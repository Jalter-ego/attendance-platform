#!/usr/bin/env bash
# apply.sh <backend|frontend> <sha12> <modo> [componente del manifest]
# Simula lo que hará Run Command: paquete en staging + ansible-playbook update.yml.
# El rol de la VM se fuerza con vm_role (el contenedor hace de backend y de frontend).
set -uo pipefail
COMP=$1 VER=$2 MODE=$3 MCOMP=${4:-$1}
STAGE=/opt/attendance/staging/$COMP-$VER
rm -rf "$STAGE"; mkdir -p "$STAGE"
/test/make-app.sh "$COMP" "$VER" "$MODE" "$STAGE/app"
rsync -a /src/ansible/ "$STAGE/ansible/"
cat > "$STAGE/manifest.json" <<J
{"format":1,"component":"$MCOMP","commit":"${VER}0000000000000000000000000000","version":"$VER","node":"24.15.0","built_at":"2026-11-14T00:00:00Z"}
J
cat > /tmp/tenant.json <<J
{"vm_role":"$COMP","tenant_id":"colegio-a","env":"test","region":"us-east-2"}
J
rm -f /var/lib/attendance/update.json
cd "$STAGE/ansible"
ANSIBLE_CONFIG=$STAGE/ansible/ansible.cfg ansible-playbook update.yml \
  -e @/tmp/tenant.json -e release_stage="$STAGE" > /tmp/ansible-$COMP-$VER.log 2>&1
RC=$?
rm -rf "$STAGE"
echo "rc=$RC"
cat /var/lib/attendance/update.json 2>/dev/null || { echo "(sin update.json)"; tail -5 /tmp/ansible-$COMP-$VER.log; }
