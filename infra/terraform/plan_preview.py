"""Resume un plan guardado sin aplicar cambios ni publicar sus valores privados."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


class PreviewError(Exception):
    pass


ACTIONS = {
    ("no-op",): "no-op",
    ("create",): "create",
    ("update",): "update",
    ("delete",): "delete",
    ("read",): "read",
    ("delete", "create"): "replace",
    ("create", "delete"): "replace",
}
LABELS = {
    "create": "Crear",
    "update": "Modificar",
    "delete": "Eliminar",
    "replace": "Reemplazar",
    "read": "Consultar",
    "move": "Mover en el estado",
    "import": "Importar al estado",
    "no-op": "Sin cambios",
}
# No se muestran politicas IAM, user_data, secretos, variables ni valores de outputs.
VISIBLE_FIELDS = {
    "aws_instance": ("instance_type", "ami"),
    "aws_ebs_volume": ("size", "type", "encrypted"),
    "aws_ec2_instance_state": ("state",),
}
RISK_LABELS = {
    "instance_removed": "La EC2 se elimina o reemplaza; habrá interrupción del servicio.",
    "instance_reconfigured": "Cambiar esta configuración de EC2 puede interrumpir el servicio.",
    "data_volume_deleted": "Se elimina un volumen EBS y se pueden perder sus datos.",
    "root_volume_deleted": "Se elimina el disco raíz de esta EC2.",
    "volume_detached": "Se desacopla un volumen; PostgreSQL puede tener que detenerse.",
    "instance_stopped": "Se detiene la EC2; su servicio deja de estar disponible.",
}


def has_true(value):
    if isinstance(value, dict):
        return any(has_true(item) for item in value.values())
    if isinstance(value, list):
        return any(has_true(item) for item in value)
    return value is True


def mask_for(mask, field):
    return mask.get(field, False) if isinstance(mask, dict) else mask


def valid_mask(value):
    if isinstance(value, dict):
        return all(valid_mask(item) for item in value.values())
    if isinstance(value, list):
        return all(valid_mask(item) for item in value)
    return value is None or isinstance(value, bool)


def visible_value(change, side, field):
    if any(has_true(mask_for(change.get(f"{phase}_sensitive", {}), field)) for phase in ("before", "after")):
        return "<sensible>"
    if side == "after" and has_true(mask_for(change.get("after_unknown", {}), field)):
        return "<conocido al aplicar>"
    value = (change.get(side) or {}).get(field)
    return value if value is None or isinstance(value, (str, int, float, bool)) else "<omitido>"


def changed_fields(change):
    before, after = change.get("before") or {}, change.get("after") or {}
    unknown = change.get("after_unknown", {})
    keys = set(before) | set(after) | (set(unknown) if isinstance(unknown, dict) else set())
    return sorted(key for key in keys if before.get(key) != after.get(key) or has_true(mask_for(unknown, key)))


def resource_risks(resource_type, actions, fields, change):
    risks = []
    before, after = change.get("before") or {}, change.get("after") or {}
    if "delete" in actions:
        if resource_type == "aws_ebs_volume":
            risks.append("data_volume_deleted")
        if resource_type == "aws_volume_attachment":
            risks.append("volume_detached")
        if resource_type == "aws_instance":
            risks.append("instance_removed")
            if any(disk.get("delete_on_termination") for disk in before.get("root_block_device", [])):
                risks.append("root_volume_deleted")
    elif resource_type == "aws_instance" and actions == ["update"]:
        if set(fields) & {"instance_type", "ami", "user_data", "user_data_base64"}:
            risks.append("instance_reconfigured")
    if resource_type == "aws_ec2_instance_state" and actions == ["update"] and after.get("state") == "stopped":
        risks.append("instance_stopped")
    return risks


def summarize(plan):
    if not isinstance(plan, dict) or not str(plan.get("format_version", "")).startswith("1."):
        raise PreviewError("Formato de plan no compatible; se requiere JSON con format_version 1.x.")
    if "planned_values" not in plan and "resource_changes" not in plan:
        raise PreviewError("El archivo no es un plan: no uses un tfstate ni la salida JSON de eventos.")
    if any(key in plan and not isinstance(plan[key], bool) for key in ("complete", "applyable", "errored")):
        raise PreviewError("Los indicadores de estado del plan no son válidos.")
    resources = plan.get("resource_changes", [])
    if not isinstance(resources, list):
        raise PreviewError("La lista de cambios del plan no es válida.")
    result = {
        "summary_version": 1,
        "complete": plan.get("complete"),
        "applyable": plan.get("applyable"),
        "errored": plan.get("errored", False),
        "totals": {action: 0 for action in LABELS if action != "no-op"},
        "has_deletions": False,
        "data_volumes_deleted": [],
        "changes": [],
        "outputs_changed": [],
        "warnings": [],
    }
    for resource in resources:
        if not isinstance(resource, dict) or not isinstance(resource.get("change"), dict):
            raise PreviewError("Un recurso del plan tiene un cambio no válido.")
        change = resource["change"]
        if any(change.get(side) is not None and not isinstance(change[side], dict) for side in ("before", "after")):
            raise PreviewError("Los valores de un recurso no tienen una estructura válida.")
        if not all(valid_mask(change.get(key)) for key in ("before_sensitive", "after_sensitive", "after_unknown")):
            raise PreviewError("Las marcas de sensibilidad o valores desconocidos no son válidas.")
        actions = change.get("actions")
        if not isinstance(actions, list) or not all(isinstance(action, str) for action in actions):
            raise PreviewError("Un recurso del plan no tiene acciones válidas.")
        action = ACTIONS.get(tuple(actions))
        if action is None:
            raise PreviewError("El plan contiene acciones no compatibles; revísalo con el CLI del motor.")
        address, resource_type = resource.get("address"), resource.get("type")
        if not isinstance(address, str) or not isinstance(resource_type, str):
            raise PreviewError("Un recurso no contiene dirección o tipo válidos.")
        imported = bool(change.get("importing"))
        previous = resource.get("previous_address")
        moved = isinstance(previous, str) and previous != address
        if action == "no-op" and not moved and not imported:
            continue
        for verb in ("create", "update", "delete", "read"):
            result["totals"][verb] += int(verb in actions)
        result["totals"]["replace"] += int(action == "replace")
        result["totals"]["move"] += int(moved)
        result["totals"]["import"] += int(imported)
        result["has_deletions"] |= "delete" in actions
        fields = changed_fields(change)
        risks = resource_risks(resource_type, actions, fields, change)
        if "data_volume_deleted" in risks:
            result["data_volumes_deleted"].append(address)
        details = {}
        for field in VISIBLE_FIELDS.get(resource_type, ()):
            if field in fields:
                details[field] = {side: visible_value(change, side, field) for side in ("before", "after")}
        result["changes"].append({
            "address": address,
            "type": resource_type,
            "action": action if action != "no-op" else ("import" if imported else "move"),
            "previous_address": previous if moved else None,
            "imported": imported,
            "changed_attributes": fields,
            "details": details,
            "risks": risks,
        })
    for name, change in (plan.get("output_changes") or {}).items():
        if change.get("actions") != ["no-op"]:
            result["outputs_changed"].append(name)
    if result["errored"]:
        result["warnings"].append("La planificación falló; este plan no debe aplicarse.")
    if result["complete"] is False:
        result["warnings"].append("El plan es incompleto: no representa todavía el resultado final de toda la infraestructura.")
    if result["applyable"] is False and result["changes"]:
        result["warnings"].append("El motor indica que este plan no se puede aplicar.")
    return result


def render_text(summary):
    totals = summary["totals"]
    lines = [
        f"Crear: {totals['create']} | Modificar: {totals['update']} | Eliminar: {totals['delete']} | Reemplazar: {totals['replace']}",
        "Los reemplazos cuentan también como una creación y una eliminación.",
    ]
    for warning in summary["warnings"]:
        lines.append(f"AVISO: {warning}")
    if not summary["changes"]:
        lines.append("Sin cambios de recursos en este plan.")
    for change in summary["changes"]:
        lines.append(f"- {LABELS[change['action']]}: {json.dumps(change['address'], ensure_ascii=False)}")
        if change["previous_address"]:
            lines.append(f"  Dirección anterior: {json.dumps(change['previous_address'], ensure_ascii=False)}")
        if change["imported"] and change["action"] != "import":
            lines.append("  Incluye importación al estado.")
        for field, values in change["details"].items():
            lines.append(f"  {field}: {json.dumps(values['before'], ensure_ascii=False)} → {json.dumps(values['after'], ensure_ascii=False)}")
        if change["action"] == "update" and change["changed_attributes"]:
            lines.append(f"  Atributos: {json.dumps(change['changed_attributes'], ensure_ascii=False)}")
        for risk in change["risks"]:
            lines.append(f"  AVISO: {RISK_LABELS[risk]}")
    if summary["outputs_changed"]:
        lines.append(f"Outputs modificados (sin valores): {json.dumps(summary['outputs_changed'], ensure_ascii=False)}")
    return "\n".join(lines)


def load_plan(args):
    if args.json_file:
        try:
            raw = Path(args.json_file).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise PreviewError("No se pudo leer el archivo JSON del plan.") from error
    else:
        directory, plan_file = Path(args.directory).resolve(), Path(args.plan).resolve()
        if not directory.is_dir() or not plan_file.is_file():
            raise PreviewError("No existe el directorio de Terraform o el archivo del plan.")
        try:
            process = subprocess.run(
                [args.engine, f"-chdir={directory}", "show", "-json", str(plan_file)],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
            raise PreviewError("No se pudo ejecutar show -json; comprueba el motor y sus proveedores.") from error
        if process.returncode:
            # stderr puede contener datos del plan: no se incluye en el resumen.
            raise PreviewError("El motor no pudo abrir el plan. Usa su versión y proveedores originales en un directorio inicializado.")
        raw = process.stdout
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise PreviewError("El archivo no contiene un único plan JSON válido.") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--plan", help="Plan binario guardado; la ruta parte del directorio actual.")
    source.add_argument("--json-file", help="Plan ya convertido con show -json.")
    parser.add_argument("--directory", default=".", help="Directorio inicializado del módulo (para --plan).")
    parser.add_argument("--engine", choices=("terraform", "tofu"), default="terraform")
    parser.add_argument("--output", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    try:
        summary = summarize(load_plan(args))
    except (PreviewError, TypeError, AttributeError, ValueError) as error:
        message = str(error) if isinstance(error, PreviewError) else "La estructura del plan no es válida."
        print(f"Error: {message}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2) if args.output == "json" else render_text(summary))
    return 1 if summary["errored"] else 0


if __name__ == "__main__":
    sys.exit(main())
