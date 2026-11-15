#!/usr/bin/env bash
# Prueba LOCAL de tests/isolation.sh, sin AWS: dos tenants en Docker, cada uno con frontend
# (nginx), backend REAL (paquete de build-release.sh) y PostgreSQL, en redes Docker separadas
# que hacen de Security Groups. La AWS CLI la reemplaza fake-aws.sh (Run Command = docker exec,
# IAM por prefijo de tenant), respondiendo con \r\n como la de Windows.
#
#   bash tests/isolation-sim/run.sh [carpeta de paquetes, por defecto dist-releases] [--keep]
#
# Escenario 1 (aislado): isolation.sh debe pasar entero.
# Escenario 2 (fuga provocada): A se conecta a la red de B y B usa el JWT_SECRET de A;
#   isolation.sh DEBE fallar en la red y en la comparación de secretos (detecta la fuga).
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PKGS=$(cd "${1:-$REPO/dist-releases}" 2>/dev/null && pwd) || { echo "ERROR: no existe la carpeta de paquetes"; exit 1; }
KEEP=false; [ "${2:-}" = --keep ] || [ "${1:-}" = --keep ] && KEEP=true
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
export MSYS_NO_PATHCONV=1

BACKEND_PKG=$(cd "$PKGS" && ls -t backend-*.tar.gz 2>/dev/null | head -1)
[ -n "$BACKEND_PKG" ] || { echo "ERROR: falta backend-*.tar.gz en $PKGS (infra/app-update/build-release.sh)"; exit 1; }

STATE=$(mktemp -d)
export FAKE_STATE="$STATE" FAKE_CRLF=${FAKE_CRLF:-1}
mkdir -p "$STATE/bin"
sed 's/\r$//' "$HERE/fake-aws.sh" > "$STATE/bin/aws" && chmod +x "$STATE/bin/aws"
export PATH="$STATE/bin:$PATH"

TENANTS=(colegio-a colegio-b)
declare -A PORT=([colegio-a]=18091 [colegio-b]=18092)
rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cleanup() {
  for t in "${TENANTS[@]}"; do docker rm -f "p4-iso-$t" >/dev/null 2>&1; docker network rm "p4-net-$t" >/dev/null 2>&1; done
}

echo "== Imagen de la VM simulada"
docker build -q -t p4-e2-vm "$(host_path "$REPO/infra/ansible/tests/update")" >/dev/null || exit 1
cleanup

for t in "${TENANTS[@]}"; do
  echo "== Tenant $t/test (red p4-net-$t, frontend en 127.0.0.1:${PORT[$t]})"
  docker network create "p4-net-$t" >/dev/null
  docker run -d --name "p4-iso-$t" --network "p4-net-$t" -p "${PORT[$t]}:80" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -v "$(host_path "$REPO/infra/ansible/tests/update"):/test-src:ro" -v "$(host_path "$HERE"):/sim:ro" \
    -v "$(host_path "$REPO/infra/ansible"):/src/ansible:ro" -v "$(host_path "$PKGS"):/pkgs:ro" p4-e2-vm >/dev/null || exit 1
  # Secretos propios del tenant, como los crea el servicio SSM de P6.
  for key in db_password jwt_secret admin_password; do
    mkdir -p "$STATE/secrets/tenants/$t/test"; rand > "$STATE/secrets/tenants/$t/test/$key"
  done
  echo "127.0.0.1:${PORT[$t]}" > "$STATE/public-$t"
done
sleep 4
for t in "${TENANTS[@]}"; do
  ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"p4-net-$t\").IPAddress}}" "p4-iso-$t")
  s="$STATE/secrets/tenants/$t/test"
  docker exec -e TENANT="$t" -e TENANT_ENV=test -e MY_IP="$ip" -e BACKEND_PKG="$BACKEND_PKG" \
    -e DB_PASSWORD="$(cat "$s/db_password")" -e JWT_SECRET="$(cat "$s/jwt_secret")" \
    -e ADMIN_EMAIL="admin@$t.example.com" -e ADMIN_PASSWORD="$(cat "$s/admin_password")" "p4-iso-$t" bash -c '
      mkdir -p /test && for f in /test-src/*; do sed "s/\r$//" "$f" > /test/$(basename "$f"); done; chmod +x /test/*.sh
      sed "s/\r$//" /sim/setup-tenant.sh > /tmp/setup-tenant.sh && bash /tmp/setup-tenant.sh' | sed 's/^/   /' \
    || { echo "ERROR: no se pudo preparar $t"; cleanup; exit 1; }
done

ISO="$REPO/tests/isolation.sh"
echo; echo "######## Escenario 1: tenants aislados → debe PASAR ########"
OUT1=$(bash "$ISO" --a colegio-a/test --b colegio-b/test --bucket sim-bucket 2>&1); RC1=$?
echo "$OUT1" | grep -vE '^\{' | sed 's/^/   /'

echo; echo "######## Escenario 2: fuga provocada → debe FALLAR (detectarla) ########"
docker network connect p4-net-colegio-b p4-iso-colegio-a                           # "SG" abierto de A hacia B
cp "$STATE/secrets/tenants/colegio-a/test/jwt_secret" "$STATE/secrets/tenants/colegio-b/test/jwt_secret"
docker exec p4-iso-colegio-b bash -c "sed -i 's/^JWT_SECRET=.*/JWT_SECRET=$(cat "$STATE/secrets/tenants/colegio-a/test/jwt_secret")/' /etc/attendance/backend.env && systemctl restart attendance-backend"
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT[colegio-b]}/core/api/v1/health")" = 200 ] && break; sleep 2; done
OUT2=$(bash "$ISO" --a colegio-a/test --b colegio-b/test --bucket sim-bucket 2>&1); RC2=$?
echo "$OUT2" | grep -vE '^\{' | sed 's/^/   /'

echo; echo "######## Resultado de la simulación ########"
PASS=0 FAIL=0
expect() { if eval "$2"; then PASS=$((PASS + 1)); echo "OK     $1"; else FAIL=$((FAIL + 1)); echo "FALLA  $1"; fi; }
expect "escenario 1: isolation.sh pasa entero (código 0)" "[ $RC1 -eq 0 ] && grep -q '\"status\":\"passed\"' <<<\"\$OUT1\""
expect "escenario 1: JSON final válido" "tail -n 1 <<<\"\$OUT1\" | node -e 'JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"))'"
expect "escenario 2: isolation.sh falla (código ≠ 0)" "[ $RC2 -ne 0 ]"
expect "escenario 2: detecta red abierta A → B" "grep -q 'FALLA  1.A  backend A → BD de B:5432 bloqueado' <<<\"\$OUT2\""
expect "escenario 2: detecta jwt_secret repetido" "grep -q 'FALLA  2    jwt_secret de A ≠ jwt_secret de B' <<<\"\$OUT2\""
expect "escenario 2: el token de A sigue sin valer en B (el core valida el usuario en SU BD)" "grep -q 'OK     3.A  token de A en la API de B rechazado' <<<\"\$OUT2\""
leaked=0
for f in "$STATE"/secrets/tenants/*/test/*; do grep -qF -- "$(cat "$f")" <<<"$OUT1$OUT2" && leaked=1; done
expect "ningún secreto (contraseñas de BD, JWT, admin) aparece en la salida" "[ $leaked -eq 0 ]"
echo "== $PASS correctos, $FAIL fallidos"

if $KEEP; then echo "(contenedores p4-iso-* conservados; borrar con: docker rm -f p4-iso-colegio-a p4-iso-colegio-b)"; else cleanup; fi
rm -rf "$STATE"
[ "$FAIL" -eq 0 ]
