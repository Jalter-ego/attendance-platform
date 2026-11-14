#!/usr/bin/env bash
# Prueba local de update.yml (E2) en una "VM de tenant" simulada con Docker: Ubuntu 24.04 +
# systemd + nginx + ansible-core de apt (igual que la AMI). La app es falsa (node mínimo y un
# sequelize-cli de mentira): se prueba la lógica de Ansible, no attendance-core.
#
#   bash infra/ansible/tests/update/run.sh          # crea la VM, corre los casos y la deja viva
#   bash infra/ansible/tests/update/run.sh --rm     # igual, y borra el contenedor al final
#
# Funciona desde Git Bash o WSL. Requiere Docker Desktop encendido.
# Después, para mirar por dentro:  docker exec -it p4-e2 bash
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ANSIBLE_DIR=$(cd "$HERE/../.." && pwd)
NAME=p4-e2 IMAGE=p4-e2-vm
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
export MSYS_NO_PATHCONV=1

echo "== Imagen $IMAGE"
docker build -q -t "$IMAGE" "$(host_path "$HERE")" >/dev/null || exit 1

echo "== VM simulada $NAME"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$(host_path "$HERE"):/test-src:ro" -v "$(host_path "$ANSIBLE_DIR"):/src/ansible:ro" \
  "$IMAGE" >/dev/null || exit 1
sleep 4
# Copia los scripts sin \r (checkouts de Windows) y prepara la VM como si boot.yml ya hubiera corrido.
docker exec "$NAME" bash -c 'mkdir -p /test && for f in /test-src/*.sh; do sed "s/\r$//" "$f" > /test/$(basename "$f"); done; chmod +x /test/*.sh; /test/setup-vm.sh' >/dev/null 2>&1 \
  || { echo "ERROR: no se pudo preparar la VM"; exit 1; }
echo "   ansible: $(docker exec "$NAME" ansible --version | head -1)"

PASS=0 FAIL=0
# caso <descripción> <estado esperado> <args de apply.sh...>
caso() {
  local desc=$1 want=$2; shift 2
  local json got
  json=$(docker exec "$NAME" /test/apply.sh "$@" | sed -n 2p)
  got=$(echo "$json" | docker exec -i "$NAME" jq -r .status 2>/dev/null) || got=rechazado
  [ -n "$got" ] || got=rechazado
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); mark=OK; else FAIL=$((FAIL+1)); mark=FALLA; fi
  printf '%-6s %-38s esperado=%-11s obtenido=%-11s %s\n' "$mark" "$desc" "$want" "$got" \
    "$(echo "$json" | docker exec -i "$NAME" jq -r '"\(.from // "")→\(.to // "") \(.error // "")"' 2>/dev/null | cut -c1-90)"
}

echo "== Casos"
caso "1 backend nuevo"                    succeeded   backend  bbbbbbbbbbbb ok
caso "2 backend que no arranca"           rolled_back backend  cccccccccccc broken
caso "3 la migración falla"               failed      backend  dddddddddddd migrate-fail
caso "4 misma versión otra vez"           succeeded   backend  bbbbbbbbbbbb ok
caso "5 paquete de otro componente"       rechazado   backend  eeeeeeeeeeee ok frontend
caso "6 frontend por primera vez"         succeeded   frontend 111111111111 ok
caso "7 frontend sin index.html"          failed      frontend 222222222222 no-index
caso "8 frontend nuevo"                   succeeded   frontend 333333333333 ok
docker exec "$NAME" bash -c 'echo "garbage;" > /etc/nginx/conf.d/roto.conf'
caso "9 nginx falla tras el cambio"       rolled_back frontend 777777777777 ok
docker exec "$NAME" rm -f /etc/nginx/conf.d/roto.conf
for v in 444444444444 555555555555 666666666666; do docker exec "$NAME" /test/apply.sh backend $v ok >/dev/null; done

echo "== Estado final"
docker exec "$NAME" bash -c '
  echo "   backend-current → $(basename "$(readlink /opt/attendance/backend-current)")  $(curl -s localhost:5000/core/api/v1/health)"
  echo "   /var/www/attendance → $(basename "$(readlink /var/www/attendance)")  $(curl -s localhost/)"
  echo "   releases: $(ls /opt/attendance/releases | tr "\n" " ")"'
want_rel="backend-444444444444 backend-555555555555 backend-666666666666 frontend-111111111111 frontend-333333333333 frontend-ffffffffffff"
got_rel=$(docker exec "$NAME" ls /opt/attendance/releases | tr '\n' ' ' | sed 's/ $//')
if [ "$got_rel" = "$want_rel" ]; then PASS=$((PASS+1)); echo "OK     limpieza: quedan 3 backend y ninguna release fallida"
else FAIL=$((FAIL+1)); echo "FALLA  limpieza: esperado [$want_rel]"; fi

echo "== $PASS correctos, $FAIL fallidos"
[ "${1:-}" = --rm ] && docker rm -f "$NAME" >/dev/null
[ "$FAIL" -eq 0 ]
