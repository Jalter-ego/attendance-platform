#!/usr/bin/env bash
# Actualización de la app de un tenant SIN recrear sus EC2 (E2 · RF-15). Requiere AWS CLI v2.
# Contrato con el worker de P6: docs/contrato-actualizacion.md
#
#   tenant-update.sh publish --tenant <id> --env <test|prod> --file <comp>-<sha12>.tar.gz
#       sube el paquete y su .sha256 a s3://<bucket>/tenants/<id>/<env>/releases/
#   tenant-update.sh apply   --tenant <id> --env <test|prod> --component <backend|frontend> --version <sha12>
#       Run Command en la EC2 del componente: descarga, verifica, ansible update.yml, health,
#       vuelta atrás si falla
#   tenant-update.sh status  --tenant <id> --env <test|prod>
#       versión activa y última actualización de cada VM + paquetes publicados (JSON)
#
# Opciones: --region (por defecto us-east-2 o $AWS_REGION), --bucket (por defecto el de la
# base: <project>-backups-<cuenta>), --project (attendance-platform), --timeout seg (600).
# Salida: progreso legible y, en la última línea, JSON para la API. En `apply` el código de
# salida es 0 solo si status = succeeded.
set -euo pipefail

CMD="${1:-}"; shift || true
TENANT="" ENV_NAME="" FILE="" COMPONENT="" VERSION="" REGION="${AWS_REGION:-us-east-2}"
PROJECT="attendance-platform" BUCKET="" TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --component) COMPONENT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "ERROR: opción desconocida $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$CMD" =~ ^(publish|apply|status)$ ]] || die "uso: tenant-update.sh <publish|apply|status> --tenant ID --env test|prod [--file F | --component C --version V]"
[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || die "--tenant inválido"
[[ "$ENV_NAME" =~ ^(test|prod)$ ]] || die "--env debe ser test o prod"
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout debe ser un número de segundos"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
# Git Bash en Windows convierte "/opt/..." en rutas de Windows; aquí no queremos eso.
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)

if [ -z "$BUCKET" ]; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  BUCKET="$PROJECT-backups-$ACCOUNT"
fi
PREFIX="tenants/$TENANT/$ENV_NAME/releases"   # = outputs.releases.prefix del módulo de tenant

instance_of() {
  local id
  id=$(aws ec2 describe-instances --filters Name=tag:Project,Values="$PROJECT" Name=tag:Tenant,Values="$TENANT" \
    Name=tag:Env,Values="$ENV_NAME" Name=tag:Role,Values="$1" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId | [0]' --output text)
  [ -n "$id" ] && [ "$id" != None ] || die "no hay una VM $1 en ejecución para $TENANT/$ENV_NAME (¿suspendido?)"
  echo "$id"
}

# Run Command sin abortar si el comando falla: deja estado, salida y última línea JSON en
# RUN_STATUS, RUN_OUT y RUN_RESULT. El script remoto viaja en base64 (sin problemas de comillas).
run_script() {
  local instance="$1" script="$2" comment="$3" cmd_id waited=0 b64 args="${*:4}"
  b64=$(base64 < "$script" | tr -d '\n')
  local command="echo $b64 | base64 -d > /run/attendance-ssm.sh && bash /run/attendance-ssm.sh $args; rc=\$?; rm -f /run/attendance-ssm.sh; exit \$rc"
  cmd_id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --comment "$comment" --timeout-seconds 60 \
    --parameters "{\"commands\":[\"$command\"],\"executionTimeout\":[\"$TIMEOUT\"]}" \
    --query Command.CommandId --output text) || die "SSM no aceptó el comando (¿agente registrado? ¿permisos de P1 aplicados?)"
  RUN_CMD_ID="$cmd_id"
  echo "== SSM $cmd_id en $instance: $comment"
  while :; do
    RUN_STATUS=$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$RUN_STATUS" in
      Success | Failed | Cancelled | TimedOut | Cancelling) break ;;
    esac
    [ "$waited" -ge "$TIMEOUT" ] && { RUN_STATUS=TimedOut; break; }
    sleep 5; waited=$((waited + 5))
  done
  RUN_OUT=$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query StandardOutputContent --output text 2>/dev/null || true)
  local err
  err=$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query StandardErrorContent --output text 2>/dev/null || true)
  [ -n "$RUN_OUT" ] && printf '%s\n' "$RUN_OUT" | grep -vE '^\{' || true
  [ -n "$err" ] && [ "$err" != None ] && printf '%s\n' "$err" >&2
  RUN_RESULT=$(printf '%s\n' "$RUN_OUT" | grep -E '^\{' | tail -n 1 || true)
}

case "$CMD" in
  publish)
    [ -f "$FILE" ] || die "--file no existe: $FILE"
    NAME=$(basename "$FILE")
    [[ "$NAME" =~ ^(backend|frontend)-([0-9a-f]{12})\.tar\.gz$ ]] || die "nombre inválido: $NAME (esperado <backend|frontend>-<sha12>.tar.gz)"
    COMPONENT="${BASH_REMATCH[1]}" VERSION="${BASH_REMATCH[2]}"
    [ -f "$FILE.sha256" ] || die "falta $FILE.sha256 (lo genera build-release.sh)"
    SUM=$(awk '{print $1; exit}' "$FILE.sha256")
    [ "$SUM" = "$(sha256sum "$FILE" | awk '{print $1}')" ] || die "el sha256 no coincide con $FILE"
    echo "== subiendo $NAME a s3://$BUCKET/$PREFIX/"
    aws s3 cp --only-show-errors "$FILE" "s3://$BUCKET/$PREFIX/$NAME"
    aws s3 cp --only-show-errors "$FILE.sha256" "s3://$BUCKET/$PREFIX/$NAME.sha256"
    printf '{"tenant":"%s","env":"%s","component":"%s","version":"%s","key":"%s/%s","sha256":"%s"}\n' \
      "$TENANT" "$ENV_NAME" "$COMPONENT" "$VERSION" "$PREFIX" "$NAME" "$SUM"
    ;;

  apply)
    [[ "$COMPONENT" =~ ^(backend|frontend)$ ]] || die "--component debe ser backend o frontend"
    [[ "$VERSION" =~ ^[0-9a-f]{12}$ ]] || die "--version debe ser el sha de 12 caracteres"
    aws s3api head-object --bucket "$BUCKET" --key "$PREFIX/$COMPONENT-$VERSION.tar.gz" >/dev/null 2>&1 \
      || die "no está publicado $PREFIX/$COMPONENT-$VERSION.tar.gz (usar publish primero)"
    INSTANCE=$(instance_of "$COMPONENT")
    run_script "$INSTANCE" "$HERE/remote-apply.sh" "update $TENANT/$ENV_NAME $COMPONENT $VERSION" \
      "$BUCKET" "$PREFIX" "$COMPONENT" "$VERSION"
    if [ -z "$RUN_RESULT" ]; then
      RUN_RESULT=$(printf '{"status":"failed","tenant":"%s","env":"%s","component":"%s","from":"","to":"%s","rolled_back":false,"health":{"url":null,"status":0},"error":"Run Command terminó en %s sin resultado"}' \
        "$TENANT" "$ENV_NAME" "$COMPONENT" "$VERSION" "$RUN_STATUS")
    fi
    # El worker necesita saber en qué instancia y con qué comando ocurrió.
    printf '{"instance_id":"%s","command_id":"%s",%s\n' "$INSTANCE" "$RUN_CMD_ID" "${RUN_RESULT#\{}"
    [[ "$RUN_RESULT" == *'"status":"succeeded"'* ]]
    ;;

  status)
    PROBE=$(mktemp); trap 'rm -f "$PROBE"' EXIT
    cat > "$PROBE" <<'SH'
role=$(jq -r .vm_role /etc/attendance/tenant.json)
case "$role" in
  backend) link=/opt/attendance/backend-current ;;
  *) link=/var/www/attendance ;;
esac
current=$(basename "$(readlink "$link" 2>/dev/null || echo "$link")" | sed -E 's/^(backend|frontend)-//')
[ -L "$link" ] || current="horneado"
last=$(jq -c . /var/lib/attendance/update.json 2>/dev/null || echo null)
image=$(jq -r .image_version /etc/attendance/image.json 2>/dev/null || echo "")
printf '{"role":"%s","current":"%s","image_version":"%s","last_update":%s}\n' "$role" "$current" "$image" "$last"
SH
    VMS=()
    for role in backend frontend; do
      INSTANCE=$(instance_of "$role")
      run_script "$INSTANCE" "$PROBE" "status $TENANT/$ENV_NAME $role"
      [ -n "$RUN_RESULT" ] || RUN_RESULT="{\"role\":\"$role\",\"error\":\"sin respuesta ($RUN_STATUS)\"}"
      VMS+=("{\"instance_id\":\"$INSTANCE\",${RUN_RESULT#\{}")
    done
    PKGS=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/" \
      --query "Contents[?ends_with(Key, '.tar.gz')].{key: Key, bytes: Size, last_modified: LastModified}" --output json)
    [ "$PKGS" = null ] && PKGS="[]"
    printf '{"tenant":"%s","env":"%s","vms":[%s],"packages":%s}\n' \
      "$TENANT" "$ENV_NAME" "$(IFS=,; echo "${VMS[*]}")" "$(tr -d '\n' <<<"$PKGS")"
    ;;
esac
