#!/usr/bin/env bash
# Prueba de punta a punta de E2 SIN AWS: tenant-update.sh publish/apply/status con los paquetes
# REALES de build-release.sh, contra la VM simulada (Docker) con PostgreSQL y el backend real.
# La AWS CLI se reemplaza por fake-aws.sh (S3 = carpeta local, Run Command = docker exec).
#
#   bash infra/app-update/build-release.sh --component backend    # en Linux/WSL/contenedor
#   bash infra/app-update/build-release.sh --component frontend
#   bash infra/ansible/tests/update/e2e.sh [carpeta de paquetes, por defecto dist-releases]
#
# Desde Git Bash o WSL, con Docker Desktop encendido. Deja el contenedor p4-e2 vivo.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
PKGS=$(cd "${1:-$REPO/dist-releases}" && pwd)
NAME=p4-e2 IMAGE=p4-e2-vm
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
export MSYS_NO_PATHCONV=1

BACK=$(cd "$PKGS" && ls -t backend-*.tar.gz 2>/dev/null | head -1)
FRONT=$(cd "$PKGS" && ls -t frontend-*.tar.gz 2>/dev/null | head -1)
[ -n "$BACK" ] && [ -n "$FRONT" ] || { echo "ERROR: faltan paquetes en $PKGS (correr build-release.sh)"; exit 1; }
BACK_VER=$(sed -E 's/backend-(.*)\.tar\.gz/\1/' <<<"$BACK")
FRONT_VER=$(sed -E 's/frontend-(.*)\.tar\.gz/\1/' <<<"$FRONT")

WORK=$(mktemp -d)
export FAKE_S3="$WORK/s3" FAKE_STATE="$WORK/ssm" FAKE_VM="$NAME"
# Por defecto la CLI falsa responde como la de Windows (\r\n), igual que en el worker de P6.
export FAKE_CRLF=${FAKE_CRLF:-1} FAKE_PUBLIC_IP=127.0.0.1:18080
mkdir -p "$FAKE_S3" "$WORK/bin"
sed 's/\r$//' "$HERE/fake-aws.sh" > "$WORK/bin/aws" && chmod +x "$WORK/bin/aws"
export PATH="$WORK/bin:$PATH"
TU="$REPO/infra/app-update/tenant-update.sh"
COMMON=(--tenant colegio-a --env test --bucket e2e-bucket)

echo "== VM simulada $NAME (paquetes: $BACK, $FRONT)"
docker build -q -t "$IMAGE" "$(host_path "$HERE")" >/dev/null || exit 1
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p 18080:80 --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$(host_path "$HERE"):/test-src:ro" -v "$(host_path "$REPO/infra/ansible"):/src/ansible:ro" \
  -v "$(host_path "$PKGS"):/pkgs:ro" -v "$(host_path "$FAKE_S3"):/fake-s3:ro" "$IMAGE" >/dev/null || exit 1
sleep 4
docker exec "$NAME" bash -c 'mkdir -p /test && for f in /test-src/*.sh; do sed "s/\r$//" "$f" > /test/$(basename "$f"); done; chmod +x /test/*.sh; /test/setup-vm.sh && /test/setup-real.sh' >/dev/null 2>&1 \
  || { echo "ERROR: no se pudo preparar la VM"; exit 1; }
VM_ID=$(docker inspect -f '{{.Id}}' "$NAME" | cut -c1-12)

# Variante rota del backend real: mismo código, pero main.js termina al arrancar.
BAD_VER=bad0bad0bad0
docker exec "$NAME" bash -c "set -e; d=\$(mktemp -d); tar -xzf /pkgs/$BACK -C \$d
  echo 'console.error(\"arranque roto a propósito\"); process.exit(1)' > \$d/app/dist/src/main.js
  jq '.version=\"$BAD_VER\" | .commit=\"${BAD_VER}0000000000000000000000000000\"' \$d/manifest.json > \$d/m && mv \$d/m \$d/manifest.json
  tar -C \$d -czf /tmp/backend-$BAD_VER.tar.gz manifest.json app ansible
  cd /tmp && sha256sum backend-$BAD_VER.tar.gz > backend-$BAD_VER.tar.gz.sha256" || { echo "ERROR: no se pudo armar el paquete roto"; exit 1; }
docker cp "$NAME:/tmp/backend-$BAD_VER.tar.gz" "$(host_path "$WORK")/" >/dev/null
docker cp "$NAME:/tmp/backend-$BAD_VER.tar.gz.sha256" "$(host_path "$WORK")/" >/dev/null

PASS=0 FAIL=0
check() { if eval "$2"; then PASS=$((PASS+1)); echo "OK     $1"; else FAIL=$((FAIL+1)); echo "FALLA  $1"; fi; }
vm() { docker exec "$NAME" bash -c "$1"; }
last_json() { tail -n 1; }

echo "== 1. publish + apply backend $BACK_VER (migraciones reales, /health con BD)"
OUT=$(bash "$TU" publish "${COMMON[@]}" --file "$PKGS/$BACK" | last_json); echo "   $OUT"
check "publish backend sube paquete y sha256" "[ -f '$FAKE_S3/e2e-bucket/tenants/colegio-a/test/releases/$BACK.sha256' ]"
OUT=$(bash "$TU" apply "${COMMON[@]}" --component backend --version "$BACK_VER" | last_json); RC=$?; echo "   $OUT"
check "apply backend → succeeded" "[[ '$OUT' == *'\"status\":\"succeeded\"'* ]]"
check "backend-current = $BACK_VER" "[ \"\$(vm 'basename \$(readlink /opt/attendance/backend-current)')\" = backend-$BACK_VER ]"
check "/core/api/v1/health = 200 (app real)" "[ \"\$(vm 'curl -s -o /dev/null -w %{http_code} localhost:5000/core/api/v1/health')\" = 200 ]"
check "migraciones aplicadas (SequelizeMeta)" "[ \"\$(vm \"PGPASSWORD=e2e-password-0123456789 psql -tA -h 127.0.0.1 -U attendance attendance -c 'select count(*)>0 from \\\"SequelizeMeta\\\"'\")\" = t ]"

echo "== 2. publish + apply frontend $FRONT_VER"
bash "$TU" publish "${COMMON[@]}" --file "$PKGS/$FRONT" >/dev/null
OUT=$(bash "$TU" apply "${COMMON[@]}" --component frontend --version "$FRONT_VER" | last_json); echo "   $OUT"
check "apply frontend → succeeded" "[[ '$OUT' == *'\"status\":\"succeeded\"'* ]]"
check "nginx sirve el build nuevo" "vm 'diff -q <(curl -s localhost/) /opt/attendance/releases/frontend-$FRONT_VER/index.html' >/dev/null"

echo "== 3. backend roto → vuelta atrás"
bash "$TU" publish "${COMMON[@]}" --file "$WORK/backend-$BAD_VER.tar.gz" >/dev/null
OUT=$(bash "$TU" apply "${COMMON[@]}" --component backend --version "$BAD_VER" | last_json); RC=$?; echo "   ${OUT:0:220}…"
check "apply roto → rolled_back y código de salida ≠ 0" "[[ '$OUT' == *'\"status\":\"rolled_back\"'* ]] && [ $RC -ne 0 ]"
check "sigue en $BACK_VER con health 200" "[ \"\$(vm 'basename \$(readlink /opt/attendance/backend-current)')\" = backend-$BACK_VER ] && [ \"\$(vm 'curl -s -o /dev/null -w %{http_code} localhost:5000/core/api/v1/health')\" = 200 ]"

echo "== 4. errores de uso"
bash "$TU" apply "${COMMON[@]}" --component backend --version 0123456789ab >/dev/null 2>&1; RC=$?
check "apply de versión no publicada → error" "[ $RC -ne 0 ]"
bash "$TU" publish "${COMMON[@]}" --file "$PKGS/$BACK.sha256" >/dev/null 2>&1; RC=$?
check "publish de un archivo con nombre inválido → error" "[ $RC -ne 0 ]"

echo "== 5. status"
OUT=$(bash "$TU" status "${COMMON[@]}" | last_json); echo "   ${OUT:0:300}…"
check "status: backend $BACK_VER y frontend $FRONT_VER" "[[ '$OUT' == *'\"role\":\"backend\",\"current\":\"$BACK_VER\"'* && '$OUT' == *'\"role\":\"frontend\",\"current\":\"$FRONT_VER\"'* ]]"

echo "== 6. sin recrear infraestructura"
check "misma VM (contenedor $VM_ID)" "[ \"\$(docker inspect -f '{{.Id}}' $NAME | cut -c1-12)\" = $VM_ID ]"
check "el dato previo sigue en la BD" "[ \"\$(vm \"PGPASSWORD=e2e-password-0123456789 psql -tA -h 127.0.0.1 -U attendance attendance -c 'select nota from e2e_marcador'\")\" = 'dato creado antes de actualizar' ]"

echo "== 7. tenant-health.sh (E6)"
TH="$REPO/infra/health/tenant-health.sh"
HC=(--tenant colegio-a --env test --timeout 6 --interval 2)
OUT=$(bash "$TH" "${HC[@]}" --boot | tail -n 1); RC=$?; echo "   ${OUT:0:260}…"
check "sano: IP pública por etiquetas, frontend y backend 200, código 0" "[[ '$OUT' == *'\"status\":\"healthy\"'* ]] && [ $RC -eq 0 ]"
check "--boot: boot.json de las 3 VMs" "[ \$(grep -o '\"status\":\"ready\"' <<<'$OUT' | wc -l) -eq 3 ]"
vm 'systemctl stop attendance-backend'
OUT=$(bash "$TH" "${HC[@]}" --url http://127.0.0.1:18080/ | tail -n 1); RC=$?
check "API caída → unhealthy, backend 502, código ≠ 0" "[[ '$OUT' == *'\"status\":\"unhealthy\"'* && '$OUT' == *'nginx no llega al backend'* ]] && [ $RC -ne 0 ]"
# La API tiene que estar arriba antes de cortar la BD: sin BD, NestJS ni siquiera arranca (502).
vm 'systemctl start attendance-backend'
bash "$TH" "${HC[@]}" --url http://127.0.0.1:18080/ --timeout 60 >/dev/null
vm 'systemctl stop postgresql'
OUT=$(bash "$TH" "${HC[@]}" --url http://127.0.0.1:18080/ --timeout 30 | tail -n 1)
check "BD caída → unhealthy, backend 503" "[[ '$OUT' == *'\"status\":503'* && '$OUT' == *'no llega a su base de datos'* ]]"
vm 'systemctl start postgresql'
OUT=$(bash "$TH" "${HC[@]}" --url http://127.0.0.1:18080/ --timeout 60 | tail -n 1); RC=$?
check "se recupera → healthy con reintentos" "[[ '$OUT' == *'\"status\":\"healthy\"'* ]] && [ $RC -eq 0 ]"
OUT=$(bash "$TH" "${HC[@]}" --url http://127.0.0.1:1/ --timeout 2 | tail -n 1)
check "sin respuesta del frontend → status 0 y JSON válido" "node -e 'const j=JSON.parse(process.argv[1]); process.exit(j.checks.frontend.status===0?0:1)' '$OUT'"

echo "== 8. boot_backend espera /health (sobre la release activa, con la BD real)"
BOOT_VARS='{"tenant_id":"colegio-a","env":"test","plan":"basic","institution_name":"Colegio A","timezone":"America/La_Paz","limits":{"max_students":100,"max_teachers":10,"max_courses":20},"db_host":"127.0.0.1","db_password":"e2e-password-0123456789","jwt_secret":"e2e-jwt-secret-0123456789-0123456789-0123456789","ssm_prefix":"/tenants/colegio-a/test"}' # gitleaks:allow -- token ficticio exclusivo de esta prueba local
vm "cd /src/ansible && ANSIBLE_CONFIG=/src/ansible/ansible.cfg ANSIBLE_ROLES_PATH=/src/ansible/roles ansible-playbook /test-src/boot-backend.yml -i /src/ansible/inventory.ini -e '$BOOT_VARS'" > "$WORK/boot.log" 2>&1; RC=$?
grep -E 'TASK \[boot_backend : Esperar|^ok:|PLAY RECAP|localhost +:' "$WORK/boot.log" | tail -n 3 | sed 's/^/   /'
check "boot_backend termina con /health 200 (backend.env, migraciones, API)" "[ $RC -eq 0 ] && grep -q 'Esperar /health = 200' '$WORK/boot.log'"
check "backend.env con PLAN_MAX_* del tenant" "vm 'grep -q ^PLAN_MAX_STUDENTS=100 /etc/attendance/backend.env'"

echo "== $PASS correctos, $FAIL fallidos   (log de Ansible: docker exec $NAME cat /var/log/attendance-update.log)"
[ "$FAIL" -eq 0 ]
