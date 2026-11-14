#!/usr/bin/env bash
# Parte de tenant-update.sh que corre DENTRO de la EC2 (SSM Run Command, como root).
# No está horneado en la AMI: tenant-update.sh lo envía en cada `apply`.
#
#   remote-apply.sh <bucket> <prefijo releases> <backend|frontend> <sha12>
#
# Descarga el paquete del prefijo del tenant, verifica su sha256, lo extrae y corre
# ansible/update.yml (que viene dentro del paquete). Imprime un resumen y, en la ÚLTIMA
# línea, el JSON de docs/contrato-actualizacion.md. Sale con 0 si pudo producir ese JSON
# (aunque sea failed/rolled_back); el estado real lo decide quien lee el JSON.
set -uo pipefail

BUCKET=${1:-} PREFIX=${2:-} COMP=${3:-} VER=${4:-}
ROOT=/opt/attendance ETC=/etc/attendance STATE=/var/lib/attendance
LOG=/var/log/attendance-update.log
STAGE="$ROOT/staging/$COMP-$VER"

FROM=""
result_failed() {
  jq -cn --arg e "$1" --arg c "$COMP" --arg f "$FROM" --arg t "$VER" --slurpfile tj "$ETC/tenant.json" \
    '{status: "failed", tenant: $tj[0].tenant_id, env: $tj[0].env, component: $c, from: $f, to: $t,
      rolled_back: false, health: {url: null, status: 0}, error: $e, finished_at: (now | todate)}'
  rm -rf "$STAGE"
  exit 0
}

[[ "$COMP" =~ ^(backend|frontend)$ && "$VER" =~ ^[0-9a-f]{12}$ && -n "$BUCKET" && -n "$PREFIX" ]] \
  || { echo '{"status":"failed","error":"argumentos inválidos para remote-apply.sh"}'; exit 0; }
[ -f "$ETC/tenant.json" ] || { echo '{"status":"failed","error":"falta /etc/attendance/tenant.json"}'; exit 0; }

ROLE=$(jq -r .vm_role "$ETC/tenant.json")
REGION=$(jq -r .region "$ETC/tenant.json")
case "$COMP" in
  backend) FROM=$(basename "$(readlink "$ROOT/backend-current" 2>/dev/null)" | sed 's/^backend-//') ;;
  frontend) FROM=$(basename "$(readlink /var/www/attendance 2>/dev/null)" | sed 's/^frontend-//') ;;
esac
[ "$ROLE" = "$COMP" ] || result_failed "esta VM es $ROLE, no $COMP"

# Una actualización a la vez por VM.
exec 9>/run/attendance-update.lock
flock -n 9 || result_failed "ya hay otra actualización en curso en esta VM"

echo "== $COMP $FROM → $VER en $(jq -r '.tenant_id + "/" + .env' "$ETC/tenant.json")"
rm -rf "$STAGE" && install -d -m 0700 "$STAGE"
PKG="$COMP-$VER.tar.gz"
aws s3 cp --only-show-errors --region "$REGION" "s3://$BUCKET/$PREFIX/$PKG" "$STAGE/$PKG" \
  || result_failed "no se pudo descargar s3://$BUCKET/$PREFIX/$PKG"
aws s3 cp --only-show-errors --region "$REGION" "s3://$BUCKET/$PREFIX/$PKG.sha256" "$STAGE/$PKG.sha256" \
  || result_failed "no se pudo descargar $PKG.sha256"

WANT=$(awk '{print $1; exit}' "$STAGE/$PKG.sha256")
GOT=$(sha256sum "$STAGE/$PKG" | awk '{print $1}')
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || result_failed "sha256 no coincide ($GOT)"
echo "== paquete verificado ($GOT)"

tar -xzf "$STAGE/$PKG" -C "$STAGE" --no-same-owner || result_failed "no se pudo extraer el paquete"
rm -f "$STAGE/$PKG" "$STAGE/$PKG.sha256"
[ -f "$STAGE/manifest.json" ] && [ -f "$STAGE/ansible/update.yml" ] && [ -d "$STAGE/app" ] \
  || result_failed "el paquete no trae manifest.json, app/ y ansible/update.yml"

echo "== ansible-playbook update.yml (log: $LOG)"
rm -f "$STATE/update.json"
{ echo; echo "===== $(date -Is) $COMP $FROM → $VER"; } >> "$LOG"
( cd "$STAGE/ansible" && ANSIBLE_CONFIG="$STAGE/ansible/ansible.cfg" ansible-playbook update.yml \
    -e "@$ETC/tenant.json" -e "release_stage=$STAGE" ) >> "$LOG" 2>&1
RC=$?
rm -rf "$STAGE"

if [ -s "$STATE/update.json" ]; then
  [ "$RC" -eq 0 ] || { echo "== Ansible terminó con error (rc=$RC); últimas líneas:"; grep -E 'fatal:|msg:|FAILED' "$LOG" | tail -n 5; }
  jq -c . "$STATE/update.json"
else
  # Ansible se detuvo antes de los roles (p. ej. manifest de otro componente).
  MSG=$(grep -E '^\s+msg:' "$LOG" | tail -n 1 | sed -E 's/^\s+msg:\s*//')
  result_failed "Ansible rechazó el paquete: ${MSG:-ver $LOG}"
fi
