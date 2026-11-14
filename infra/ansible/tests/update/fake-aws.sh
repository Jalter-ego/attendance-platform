#!/usr/bin/env bash
# AWS CLI falsa para e2e.sh: implementa SOLO las llamadas que usan tenant-update.sh y
# remote-apply.sh. S3 = carpeta local ($FAKE_S3); Run Command = `docker exec` en la VM
# simulada ($FAKE_VM), que hace de backend o de frontend según la instancia (i-fake-<rol>).
set -uo pipefail
S3=${FAKE_S3:-/fake-s3} ST=${FAKE_STATE:-/tmp/fake-ssm} VM=${FAKE_VM:-p4-e2}

# FAKE_CRLF=1 imita la AWS CLI de Windows (la que usa el worker con Git Bash): \r\n al final.
if [ "${FAKE_CRLF:-0}" = 1 ] && [ -z "${FAKE_CRLF_INNER:-}" ]; then
  FAKE_CRLF_INNER=1 "$0" "$@" | sed 's/$/\r/'
  exit "${PIPESTATUS[0]}"
fi
svc=${1:-} op=${2:-}; shift 2 || true

arg() { local k=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "${2:-}"; return; }; shift; done; }
local_path() { echo "$S3/${1#s3://}"; }

case "$svc $op" in
  "sts get-caller-identity") echo 123456789012 ;;

  "ec2 describe-instances")
    # Con FAKE_PUBLIC_IP=127.0.0.1:18080 la "IP pública" del frontend es el puerto publicado.
    if [[ "$(arg --query "$@")" == *PublicIpAddress* ]]; then echo "${FAKE_PUBLIC_IP:-None}"; exit 0; fi
    for a in "$@"; do [[ $a == Name=tag:Role,Values=* ]] && echo "i-fake-${a##*=}"; done ;;

  "s3 cp")
    paths=()
    while [ $# -gt 0 ]; do
      case "$1" in --region) shift 2 ;; --*) shift ;; *) paths+=("$1"); shift ;; esac
    done
    src=${paths[0]} dst=${paths[1]}
    [[ $src == s3://* ]] && src=$(local_path "$src")
    [[ $dst == s3://* ]] && dst=$(local_path "$dst")
    [ -f "$src" ] || { echo "fatal error: An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 1; }
    mkdir -p "$(dirname "$dst")" && cp "$src" "$dst" ;;

  "s3api head-object")
    [ -f "$S3/$(arg --bucket "$@")/$(arg --key "$@")" ] || exit 254 ;;

  "s3api list-objects-v2")
    b=$(arg --bucket "$@") p=$(arg --prefix "$@") sep=""
    printf '['
    while IFS= read -r f; do
      printf '%s{"key":"%s","bytes":%s,"last_modified":"%s"}' "$sep" "$p${f#./}" "$(stat -c %s "$S3/$b/$p$f")" \
        "$(date -u -r "$S3/$b/$p$f" +%Y-%m-%dT%H:%M:%S+00:00)"
      sep=","
    done < <(cd "$S3/$b/$p" 2>/dev/null && find . -maxdepth 1 -name '*.tar.gz' | sort)
    echo ']' ;;

  "ssm send-command")
    inst=$(arg --instance-ids "$@") params=$(arg --parameters "$@")
    cmd=$(node -e 'console.log(JSON.parse(process.argv[1]).commands[0])' "$params")
    role=${inst#i-fake-} id="fake-$(date +%s)-$RANDOM"
    mkdir -p "$ST"
    # El contenedor hace de las dos VMs: se le cambia el rol antes de ejecutar.
    if docker exec "$VM" bash -c "jq '.vm_role=\"$role\"' /etc/attendance/tenant.json > /tmp/t.json && cat /tmp/t.json > /etc/attendance/tenant.json; $cmd" \
         > "$ST/$id.out" 2> "$ST/$id.err"; then echo Success > "$ST/$id.status"; else echo Failed > "$ST/$id.status"; fi
    echo "$id" ;;

  "ssm get-command-invocation")
    id=$(arg --command-id "$@")
    case "$(arg --query "$@")" in
      Status) cat "$ST/$id.status" ;;
      StandardOutputContent) cat "$ST/$id.out" ;;
      StandardErrorContent) cat "$ST/$id.err" ;;
    esac ;;

  *) echo "fake-aws: no implementado: $svc $op" >&2; exit 2 ;;
esac
