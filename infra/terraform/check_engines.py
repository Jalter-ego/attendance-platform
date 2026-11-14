#!/usr/bin/env python3
"""Comprueba los módulos en copias locales, sin backend ni credenciales AWS."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
MODULES = ("infra/bootstrap", "infra/terraform/base", "infra/terraform/tenant")


def adapt_tofu_tests(module):
    """Adapta el arnés; no cambia recursos, condiciones ni valores esperados."""
    for path in (module / "tests").glob("*.tftest.hcl"):
        text = re.sub(
            r"^[ \t]*override_during\s*=\s*(?:plan|apply)[ \t]*\n",
            "", path.read_text(), flags=re.M,
        )
        if module.name == "base":
            # OpenTofu genera strings aleatorios: el ARN debe tener formato válido.
            text = text.replace('mock_provider "aws" {', '''mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test-role" }
  }''', 1)
        if module.name == "tenant":
            # id ya está configurado en estos data sources; ToFu rechaza mockearlo.
            text = re.sub(r'^\s*id\s*=\s*"subnet-[^"]+"\s*\n', "", text, flags=re.M)
            # ToFu resuelve run.* en variables, no en assert. Comparar cada paso
            # con el anterior mantiene la comprobación de identidad por tránsito.
            previous_runs = {
                "another_tenant_has_its_own_prefix": "tenant_isolation_and_storage",
                "suspend_preserves_instances_and_data_volume": "create_running_by_default",
                "resume_refreshes_public_urls": "suspend_preserves_instances_and_data_volume",
                "app_update_permissions_and_idempotence": "resume_refreshes_public_urls",
            }
            blocks = re.split(r'(?=^run ")', text, flags=re.M)
            for i, block in enumerate(blocks):
                match = re.match(r'run "([^"]+)"', block)
                if not match or match[1] not in previous_runs:
                    continue
                previous = previous_runs[match[1]]
                block, count = re.subn(r"run\.\w+\.", "var.c6_previous.", block)
                if not count or "  variables {" not in block:
                    raise ValueError(f"Revisar adaptación de {match[1]}")
                blocks[i] = block.replace(
                    "  variables {", f"  variables {{\n    c6_previous = run.{previous}", 1,
                )
            text = "".join(blocks)
            (module / "c6_test_inputs.tf").write_text(
                'variable "c6_previous" {\n  type = any\n  default = null\n}\n'
            )
        path.write_text(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("terraform", "tofu"), default="tofu")
    parser.add_argument("--binary", help="Ruta al CLI; por defecto busca el motor en PATH")
    parser.add_argument("--plugin-dir", type=Path, help="Mirror local opcional de proveedores")
    args = parser.parse_args()
    binary = shutil.which(args.binary or args.engine)
    if not binary:
        parser.error("No se encontró el CLI. Instálalo o indica --binary.")
    binary = str(Path(binary).resolve())
    mirror = args.plugin_dir.resolve() if args.plugin_dir else None
    if mirror and not mirror.is_dir():
        parser.error("--plugin-dir debe ser un directorio existente.")

    (ROOT / ".local").mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"c6-{args.engine}-", dir=ROOT / ".local"))
    # Aísla flags, vars, estado, credenciales, configuración y overrides del CLI.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("AWS_", "TF_", "TOFU_"))}
    cli_config = work / "empty.tfrc"
    cli_config.write_text("")
    env.update({
        "TF_CLI_CONFIG_FILE": str(cli_config), "TF_IN_AUTOMATION": "1",
        "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_EC2_METADATA_DISABLED": "true", "AWS_CONFIG_FILE": "/dev/null",
        "AWS_SHARED_CREDENTIALS_FILE": "/dev/null", "CHECKPOINT_DISABLE": "1",
    })
    report = {"engine": args.engine, "mode": "mock", "modules": {}}

    def run(module, step, *command):
        result = subprocess.run(
            [binary, *command], cwd=module, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        (module / f"{step}.log").write_text(result.stdout)
        if result.returncode:
            print(result.stdout, flush=True)
            raise RuntimeError(f"Falló {module.name}/{step}; revisar {module / (step + '.log')}")
        return result.stdout

    print(f"Copias y resultados: {work}", flush=True)
    try:
        report["cli_version"] = run(work, "version", "version", "-json")
        for relative in MODULES:
            source = ROOT / relative
            module = work / source.name
            module.mkdir()
            # No copiar backend.tf, .terraform/, tfvars, planes ni estados reales.
            for path in source.glob("*.tf"):
                if path.name != "backend.tf":
                    shutil.copy2(path, module / path.name)
            shutil.copy2(source / ".terraform.lock.hcl", module / ".terraform.lock.hcl")
            shutil.copytree(source / "tests", module / "tests")
            for path in (module / "tests").glob("*.tftest.hcl"):
                content = path.read_text()
                if 'mock_provider "aws"' not in content or re.search(r'^\s*provider\s+"', content, re.M):
                    raise ValueError(f"Solo se permiten suites con AWS simulado: {path.name}")
            run(module, "fmt", "fmt", "-check")
            init = ["init", "-backend=false", "-input=false", "-no-color"]
            if args.engine == "tofu":
                # Primero validar el módulo original, sin cargar el arnés de TF.
                init.append("-test-directory=.c6-no-tests")
            if mirror:
                init.append(f"-plugin-dir={mirror}")
            run(module, "init", *init)
            # Con la fuente AWS explícita debe conservar origen, versión y hashes.
            original_lock = (source / ".terraform.lock.hcl").read_text().splitlines()[1:]
            checked_lock = (module / ".terraform.lock.hcl").read_text().splitlines()[1:]
            if original_lock != checked_lock:
                raise ValueError(f"init cambió el proveedor fijado en {relative}; revisar lock de la copia")
            validate = ["validate", "-no-color"]
            if args.engine == "tofu":
                validate.append("-no-tests")
            run(module, "validate", *validate)
            if args.engine == "tofu":
                adapt_tofu_tests(module)
                # El formato de las copias adaptadas no modifica los originales.
                run(module, "fmt-tests", "fmt", "tests", "c6_test_inputs.tf"
                    if module.name == "tenant" else "versions.tf")
                run(module, "validate-tests", "validate", "-no-color")
            run(module, "fmt-tests-check", "fmt", "-check", "-recursive")
            command = ["test", "-no-color"]
            if module.name == "tenant" and args.engine == "tofu":
                command.append("-var=engine=tofu")
            output = run(module, "test", *command)
            summary = re.search(r"Success! (\d+) passed, 0 failed\.", output)
            if not summary:
                raise ValueError(f"No se encontró el resultado de las pruebas de {relative}")
            report["modules"][relative] = {"passed": int(summary[1])}
            print(f"{relative}: fmt/validate OK; {summary[1]} pruebas superadas", flush=True)
    except (OSError, ValueError, RuntimeError) as error:
        report["error"] = str(error)
        print(error, flush=True)
        return_code = 1
    else:
        return_code = 0
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
