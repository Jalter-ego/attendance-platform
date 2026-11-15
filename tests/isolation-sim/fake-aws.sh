#!/usr/bin/env bash
# AWS CLI falsa para run.sh: SOLO las llamadas que usa tests/isolation.sh. Cada tenant es un
# contenedor (p4-iso-<tenant>) en su propia red Docker (p4-net-<tenant>), que hace de SG.
#
# Fuera de los contenedores (operador): EC2 por etiquetas, Run Command = docker exec, SSM con
#   los secretos de $FAKE_STATE/secrets.
# Dentro de un contenedor: SSM get-parameters y S3 ls con el IAM del rol ($FAKE_ROLE): backend/db
#   solo su prefijo /tenants/<id>/<env>/; frontend ningún secreto; S3 solo su releases/.
set -uo pipefail
ST=${FAKE_STATE:-/tmp/p4-iso}

# FAKE_CRLF=1 imita la AWS CLI de Windows (\r\n), como en el worker con Git Bash.
if [ "${FAKE_CRLF:-0}" = 1 ] && [ -z "${FAKE_CRLF_INNER:-}" ]; then
  FAKE_CRLF_INNER=1 "$0" "$@" | sed 's/$/\r/'
  exit "${PIPESTATUS[0]}"
fi

svc=${1:-} op=${2:-}; shift 2 || true
arg() { local k=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "${2:-}"; return; }; shift; done; }
filter() { local k=$1; shift; for a in "$@"; do [[ $a == Name=tag:$k,Values=* ]] && echo "${a##*=}"; done; }
denied() { echo "An error occurred (AccessDeniedException) when calling the $1 operation: not authorized ($2)" >&2; exit 254; }

# Identidad de la VM que llama (solo dentro de un contenedor).
own_prefix() { jq -r '"/tenants/" + .tenant_id + "/" + .env + "/"' /etc/attendance/tenant.json; }

case "$svc $op" in
  "sts get-caller-identity") echo 123456789012 ;;

  "ec2 describe-instances")
    tenant=$(filter Tenant "$@") role=$(filter Role "$@") query=$(arg --query "$@")
    container="p4-iso-$tenant"
    docker inspect "$container" >/dev/null 2>&1 || { echo None; exit 0; }
    case "$query" in
      *InstanceId*) echo "i-fake-$tenant-$role" ;;
      *PrivateIpAddress*) docker inspect -f "{{(index .NetworkSettings.Networks \"p4-net-$tenant\").IPAddress}}" "$container" ;;
      *PublicIpAddress*) cat "$ST/public-$tenant" ;;
    esac ;;

  "ssm get-parameter")
    name=$(arg --name "$@")
    if [ -f /etc/attendance/tenant.json ]; then denied GetParameter "$name"; fi   # las VMs no tienen GetParameter
    cat "$ST/secrets$name" 2>/dev/null || { echo "An error occurred (ParameterNotFound)" >&2; exit 254; } ;;

  "ssm get-parameters")
    name=$(arg --names "$@")
    case "${FAKE_ROLE:-backend}" in
      backend | db) [[ "$name" == "$(own_prefix)"* ]] || denied GetParameters "$name" ;;
      *) denied GetParameters "$name" ;;
    esac
    echo "$name" ;;

  "s3 ls")
    url=""; for a in "$@"; do [[ $a == s3://* ]] && url=$a; done
    tenant_env=$(jq -r '.tenant_id + "/" + .env' /etc/attendance/tenant.json)
    [[ "$url" == s3://*/tenants/$tenant_env/releases/* ]] || denied ListObjectsV2 "$url"
    echo "PRE ok/" ;;

  "ssm send-command")
    inst=$(arg --instance-ids "$@") params=$(arg --parameters "$@")
    cmd=$(node -e 'console.log(JSON.parse(process.argv[1]).commands[0])' "$params")
    role=${inst##*-} tenant=${inst#i-fake-}; tenant=${tenant%-*}
    id="fake-$(date +%s)-$RANDOM"
    mkdir -p "$ST/ssm"
    if docker exec -e FAKE_ROLE="$role" "p4-iso-$tenant" bash -c "$cmd" > "$ST/ssm/$id.out" 2> "$ST/ssm/$id.err"; then
      echo Success > "$ST/ssm/$id.status"; else echo Failed > "$ST/ssm/$id.status"; fi
    echo "$id" ;;

  "ssm get-command-invocation")
    id=$(arg --command-id "$@")
    case "$(arg --query "$@")" in
      Status) cat "$ST/ssm/$id.status" ;;
      StandardOutputContent) cat "$ST/ssm/$id.out" ;;
      StandardErrorContent) cat "$ST/ssm/$id.err" ;;
    esac ;;

  *) echo "fake-aws: no implementado: $svc $op" >&2; exit 2 ;;
esac
