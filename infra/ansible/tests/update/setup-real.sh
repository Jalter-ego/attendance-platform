#!/usr/bin/env bash
# Después de setup-vm.sh: BD PostgreSQL local y backend.env reales (como los deja boot_backend),
# tenant.json y la AWS CLI falsa para remote-apply.sh. Deja una fila "marcador" para comprobar
# que la actualización no toca los datos.
set -euo pipefail
systemctl enable --now postgresql >/dev/null 2>&1
for _ in $(seq 1 20); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
runuser -u postgres -- psql -q -c "CREATE ROLE attendance LOGIN PASSWORD 'e2e-password-0123456789'" 2>/dev/null || true
runuser -u postgres -- createdb -O attendance attendance 2>/dev/null || true

cat > /etc/attendance/backend.env <<'E'
NODE_ENV=production
PORT=5000
CORS_ORIGIN=*
INSTITUTION_TIMEZONE=America/La_Paz
TENANT_ID=colegio-a
TENANT_ENV=test
TENANT_PLAN=basic
INSTITUTION_NAME="Colegio A"
PLAN_MAX_STUDENTS=100
PLAN_MAX_TEACHERS=10
PLAN_MAX_COURSES=20
DB_SSL=false
DB_READ_HOST=127.0.0.1
DB_READ_PORT=5432
DB_READ_USERNAME=attendance
DB_READ_PASSWORD=e2e-password-0123456789
DB_READ_NAME=attendance
DB_WRITE_HOST=127.0.0.1
DB_WRITE_PORT=5432
DB_WRITE_USERNAME=attendance
DB_WRITE_PASSWORD=e2e-password-0123456789
DB_WRITE_NAME=attendance
JWT_SECRET=e2e-jwt-secret-0123456789-0123456789-0123456789
JWT_EXPIRES_IN=8h
E
chown root:attendance /etc/attendance/backend.env; chmod 0640 /etc/attendance/backend.env

cat > /etc/attendance/tenant.json <<'J'
{"vm_role":"backend","tenant_id":"colegio-a","env":"test","plan":"basic","region":"us-east-2","ssm_prefix":"/tenants/colegio-a/test"}
J
chmod 0640 /etc/attendance/tenant.json

sed 's/\r$//' /test-src/fake-aws.sh > /usr/local/bin/aws && chmod +x /usr/local/bin/aws

# Señal de arranque que deja attendance-boot (la lee tenant-health.sh --boot). Igual que la
# real: jq -n SIN -c (varias líneas) y con acentos, los dos casos que P3 encontró en AWS.
jq -n '{status: "ready", message: "Configuración aplicada", role: "backend", tenant_id: "colegio-a",
        env: "test", image_version: "0.2.2", finished_at: "2026-11-14T12:00:00Z"}' > /var/lib/attendance/boot.json

PGPASSWORD=e2e-password-0123456789 psql -q -h 127.0.0.1 -U attendance attendance \
  -c "CREATE TABLE IF NOT EXISTS e2e_marcador(nota text); INSERT INTO e2e_marcador VALUES ('dato creado antes de actualizar');"
echo "BD y backend.env listos"
