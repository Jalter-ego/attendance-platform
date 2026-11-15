#!/usr/bin/env bash
# Health check de despliegue de un tenant (E6), para el worker (P6) o un operador.
# Un tenant está listo solo si pasa esto (docs/contratos-integracion.md).
#
#   tenant-health.sh --tenant <id> --env <test|prod> [--url http://<ip>/] [--boot]
#
# Comprueba, a través del nginx público del frontend (las mismas URLs que outputs.urls):
#   frontend  GET <url>healthz                 200 → nginx sirve la app
#   backend   GET <url>core/api/v1/health      200 → nginx → API → PostgreSQL del tenant
# Reintenta hasta que ambos den 200 o se agote --timeout (un tenant recién creado tarda ~90 s).
#
# Opciones:
#   --url       URL pública del frontend (outputs.urls.frontend). Sin ella se busca la IP
#               pública de la EC2 frontend en ejecución por sus etiquetas.
#   --boot      además lee /var/lib/attendance/boot.json de las 3 VMs por SSM Run Command
#               (booting | ready | failed + mensaje): explica POR QUÉ no está sano.
#   --region (us-east-2 o $AWS_REGION), --project (attendance-platform),
#   --timeout seg (300), --interval seg (5)
# Salida: progreso legible y, en la última línea, JSON. Código 0 solo si status = healthy.
set -euo pipefail

TENANT="" ENV_NAME="" URL="" BOOT=false REGION="${AWS_REGION:-us-east-2}" PROJECT="attendance-platform"
TIMEOUT=300 INTERVAL=5
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --boot) BOOT=true; shift ;;
    --region) REGION="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "ERROR: opción desconocida $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || die "--tenant inválido"
[[ "$ENV_NAME" =~ ^(test|prod)$ ]] || die "--env debe ser test o prod"
[[ "$TIMEOUT" =~ ^[0-9]+$ && "$INTERVAL" =~ ^[1-9][0-9]*$ ]] || die "--timeout e --interval son segundos"
[ -z "$URL" ] || [[ "$URL" =~ ^https?://[^[:space:]]+$ ]] || die "--url inválida"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" MSYS_NO_PATHCONV=1
# AWS CLI en Windows: sin UTF-8 no puede mostrar los acentos de boot.json (probado por P3).
export AWS_CLI_OUTPUT_ENCODING=UTF-8
command -v curl >/dev/null || die "falta curl"
if $BOOT; then command -v jq >/dev/null || die "falta jq para consultar las versiones por SSM"; fi

# AWS CLI en Windows (worker con Git Bash) devuelve \r\n: se limpia todo lo que se lee de ella.
aws_text() { aws "$@" --output text | tr -d '\r'; }
# shellcheck disable=SC2054  # las comas son parte de la sintaxis de --filters de AWS
TAGS=(Name=tag:Project,Values="$PROJECT" Name=tag:Tenant,Values="$TENANT" Name=tag:Env,Values="$ENV_NAME")

if [ -z "$URL" ]; then
  IP=$(aws_text ec2 describe-instances --filters "${TAGS[@]}" Name=tag:Role,Values=frontend \
    Name=instance-state-name,Values=running --query 'Reservations[].Instances[].PublicIpAddress | [0]')
  [ -n "$IP" ] && [ "$IP" != None ] || die "no hay una VM frontend en ejecución con IP pública para $TENANT/$ENV_NAME (¿suspendido?)"
  URL="http://$IP/"
fi
URL="${URL%/}/"
FRONT_URL="${URL}healthz"
BACK_URL="${URL}core/api/v1/health"

# probe <url> → "<código http> <ms> <cuerpo recortado>"; código 0 si no hubo respuesta.
probe() {
  local out code ms body
  out=$(curl -s -m 10 -o - -w '\n%{http_code} %{time_total}' "$1" 2>/dev/null) || true
  code=$(tail -n 1 <<<"$out" | awk '{print $1 + 0}')   # "000" (sin respuesta) → 0
  ms=$(tail -n 1 <<<"$out" | awk '{printf "%d", $2 * 1000}')
  body=$(sed '$d' <<<"$out" | tr -d '\r\n"\\' | cut -c1-120)
  echo "${code:-0} ${ms:-0} $body"
}

echo "== health de $TENANT/$ENV_NAME en $URL (hasta $TIMEOUT s)"
START=$(date +%s) ATTEMPTS=0
while :; do
  ATTEMPTS=$((ATTEMPTS + 1))
  read -r F_CODE F_MS _ <<<"$(probe "$FRONT_URL")"
  read -r B_CODE B_MS B_BODY <<<"$(probe "$BACK_URL")"
  ELAPSED=$(( $(date +%s) - START ))
  echo "   intento $ATTEMPTS (${ELAPSED}s): frontend $F_CODE, backend $B_CODE"
  [ "$F_CODE" = 200 ] && [ "$B_CODE" = 200 ] && break
  [ "$ELAPSED" -ge "$TIMEOUT" ] && break
  sleep "$INTERVAL"
done

# Explicación legible para la pantalla del tenant.
reason() {
  case "$1:$2" in
    200:200) echo "" ;;
    0:*) echo "el frontend no responde (VM apagada, arrancando o sin IP pública)" ;;
    *:502|*:504) echo "nginx no llega al backend (API caída o arrancando)" ;;
    *:503) echo "la API responde pero no llega a su base de datos" ;;
    *:0) echo "sin respuesta del backend a través de nginx" ;;
    200:*) echo "el backend respondió $2" ;;
    *) echo "el frontend respondió $1" ;;
  esac
}
STATUS=unhealthy; [ "$F_CODE" = 200 ] && [ "$B_CODE" = 200 ] && STATUS=healthy
REASON=$(reason "$F_CODE" "$B_CODE")

# --boot: estado de attendance-boot en cada VM (las 3 tienen el agente SSM).
BOOT_JSON=null
if $BOOT; then
  ITEMS=()
  PROBE='
role=$(jq -r .vm_role /etc/attendance/tenant.json 2>/dev/null)
case "$role" in
  backend) link=/opt/attendance/backend-current; image_key=backend_commit ;;
  frontend) link=/var/www/attendance; image_key=frontend_commit ;;
  *) cat /var/lib/attendance/boot.json 2>/dev/null || echo null; exit 0 ;;
esac
version=$(basename "$(readlink "$link" 2>/dev/null || true)")
version=${version#"$role-"}
case "$version" in
  ""|*[!0123456789abcdef]*) version=""
esac
if [ "${#version}" -ne 12 ]; then
  version=$(jq -r --arg key "$image_key" ".[\$key] // empty" /etc/attendance/image.json 2>/dev/null)
fi
jq -c --arg version "$version" ". + {app_version: \$version}" /var/lib/attendance/boot.json 2>/dev/null || echo null
'
  PARAMETERS=$(jq -nc --arg probe "$PROBE" '{commands:[$probe],executionTimeout:["60"]}')
  for role in frontend backend db; do
    ID=$(aws_text ec2 describe-instances --filters "${TAGS[@]}" Name=tag:Role,Values="$role" \
      Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId | [0]' || true)
    if [ -z "$ID" ] || [ "$ID" = None ]; then
      ITEMS+=("{\"role\":\"$role\",\"instance_id\":null,\"boot\":null,\"error\":\"no está en ejecución\"}"); continue
    fi
    CMD_ID=$(aws_text ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
      --comment "health $TENANT/$ENV_NAME $role" --timeout-seconds 60 \
      --parameters "$PARAMETERS" \
      --query Command.CommandId || true)
    STATE="" OUT=""
    for _ in $(seq 1 12); do
      sleep 5
      STATE=$(aws_text ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" --query Status 2>/dev/null || true)
      case "$STATE" in Success | Failed | Cancelled | TimedOut) break ;; esac
    done
    [ "$STATE" = Success ] && OUT=$(aws_text ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" \
      --query StandardOutputContent | grep -E '^(\{|null)' | tail -n 1 || true)
    if [ -n "$OUT" ]; then
      ITEMS+=("{\"role\":\"$role\",\"instance_id\":\"$ID\",\"boot\":$OUT}")
    else
      ITEMS+=("{\"role\":\"$role\",\"instance_id\":\"$ID\",\"boot\":null,\"error\":\"SSM sin respuesta (${STATE:-sin comando})\"}")
    fi
  done
  BOOT_JSON="[$(IFS=,; echo "${ITEMS[*]}")]"
fi

[ "$STATUS" = healthy ] && echo "== $TENANT/$ENV_NAME sano" || echo "== $TENANT/$ENV_NAME NO sano: $REASON"
printf '{"tenant":"%s","env":"%s","status":"%s","reason":%s,"url":"%s","checks":{"frontend":{"url":"%s","status":%s,"ms":%s},"backend":{"url":"%s","status":%s,"ms":%s,"body":"%s"}},"attempts":%s,"elapsed_s":%s,"boot":%s,"checked_at":"%s"}\n' \
  "$TENANT" "$ENV_NAME" "$STATUS" "$([ -n "$REASON" ] && echo "\"$REASON\"" || echo null)" "$URL" \
  "$FRONT_URL" "$F_CODE" "$F_MS" "$BACK_URL" "$B_CODE" "$B_MS" "$B_BODY" \
  "$ATTEMPTS" "$ELAPSED" "$BOOT_JSON" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$STATUS" = healthy ]
