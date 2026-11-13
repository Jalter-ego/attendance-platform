#!/bin/bash
# Se hornea en cada AMI como /usr/local/sbin/attendance-boot y lo llama cloud-init (runcmd).
# También sirve para reintentar a mano:  sudo attendance-boot
#
# Resultado (lo puede leer el worker vía SSM o un health check):
#   /var/lib/attendance/boot.json  {"status": "ready"|"failed", "role": ..., "finished_at": ...}
#   /var/log/attendance-boot.log   salida completa (sin secretos: las tareas sensibles usan no_log)
set -uo pipefail

ETC=/etc/attendance
STATE=/var/lib/attendance
LOG=/var/log/attendance-boot.log
SECRETS=$(mktemp /run/attendance-secrets.XXXXXX.json)
trap 'rm -f "$SECRETS"' EXIT

exec > >(tee -a "$LOG") 2>&1
echo "== attendance-boot $(date -Is)"

status() {
  jq -n --arg s "$1" --arg m "${2:-}" --slurpfile t "$ETC/tenant.json" --slurpfile i "$ETC/image.json" \
    '{status: $s, message: $m, role: $t[0].vm_role, tenant_id: $t[0].tenant_id, env: $t[0].env,
      image_version: $i[0].image_version, finished_at: (now | todate)}' > "$STATE/boot.json"
}

fail() { echo "ERROR: $1"; status failed "$1"; exit 1; }

[ -f "$ETC/tenant.json" ] || fail "Falta $ETC/tenant.json (user_data de cloud-init)"
ROLE=$(jq -r .vm_role "$ETC/tenant.json")
REGION=$(jq -r .region "$ETC/tenant.json")
PREFIX=$(jq -r .ssm_prefix "$ETC/tenant.json")
status booting

# Secretos del tenant: el perfil IAM de la instancia solo puede leer SU prefijo.
if [ "$ROLE" = backend ] || [ "$ROLE" = db ]; then
  for i in 1 2 3 4 5; do
    if aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" \
         --recursive --with-decryption --output json \
         --query 'Parameters[].{k:Name,v:Value}' > "$SECRETS.raw" 2>/dev/null; then
      break
    fi
    echo "SSM no respondió (intento $i/5), reintento en 10 s"; sleep 10
  done
  [ -s "$SECRETS.raw" ] || fail "No se pudieron leer los secretos de SSM en $PREFIX"
  # [{k:"/tenants/a/prod/db_password", v:"..."}] -> {"db_password": "..."}
  jq 'map({key: (.k | split("/") | last), value: .v}) | from_entries' "$SECRETS.raw" > "$SECRETS"
  rm -f "$SECRETS.raw"
  chmod 600 "$SECRETS"
else
  echo '{}' > "$SECRETS"
fi

cd /opt/attendance/ansible || fail "Falta /opt/attendance/ansible en la AMI"
if ANSIBLE_CONFIG=/opt/attendance/ansible/ansible.cfg ansible-playbook boot.yml \
     -e "@$ETC/tenant.json" -e "@$SECRETS"; then
  status ready
  echo "== listo: $ROLE"
else
  fail "Ansible (boot.yml) falló para el rol $ROLE; ver $LOG"
fi
