#!/usr/bin/env bash
# Dentro del contenedor de UN tenant: deja frontend (nginx), backend REAL y PostgreSQL como los
# dejaría el arranque en AWS. Variables: TENANT, TENANT_ENV, MY_IP, DB_PASSWORD, JWT_SECRET,
# ADMIN_EMAIL, ADMIN_PASSWORD, BACKEND_PKG (paquete de build-release.sh en /pkgs).
set -euo pipefail

# Base de la VM simulada de las pruebas de Ansible (usuario, systemd, nginx con /core/ → :5000).
/test/setup-vm.sh >/dev/null 2>&1

# PostgreSQL escuchando en su IP privada, con contraseña (como boot_db).
PGV=$(ls /etc/postgresql); CONF=/etc/postgresql/$PGV/main
sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" "$CONF/postgresql.conf"
echo "host all all 0.0.0.0/0 scram-sha-256" >> "$CONF/pg_hba.conf"
systemctl enable --now postgresql >/dev/null 2>&1; systemctl restart postgresql
for _ in $(seq 1 20); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
runuser -u postgres -- psql -q -c "CREATE ROLE attendance LOGIN PASSWORD '$DB_PASSWORD'"
runuser -u postgres -- createdb -O attendance attendance

# Identidad del tenant (cloud-init) y AWS CLI falsa con el IAM del rol.
cat > /etc/attendance/tenant.json <<J
{"vm_role":"backend","tenant_id":"$TENANT","env":"$TENANT_ENV","plan":"basic","region":"us-east-2",
 "ssm_prefix":"/tenants/$TENANT/$TENANT_ENV","admin_email":"$ADMIN_EMAIL","db_host":"$MY_IP"}
J
sed 's/\r$//' /sim/fake-aws.sh > /usr/local/bin/aws && chmod +x /usr/local/bin/aws

# Backend real: el paquete de build-release.sh como release activa.
VER=$(basename "$BACKEND_PKG" .tar.gz | sed 's/^backend-//')
REL=/opt/attendance/releases/backend-$VER
STAGE=$(mktemp -d); tar -xzf "/pkgs/$BACKEND_PKG" -C "$STAGE"
rm -rf "$REL"; mv "$STAGE/app" "$REL"; rm -rf "$STAGE"
chown -R root:attendance "$REL"; chmod -R u=rwX,g=rX,o= "$REL"
ln -sfn "$REL" /opt/attendance/backend-current

# boot_backend real: backend.env con SUS secretos, migraciones, admin inicial, API y /health.
VARS=$(jq -cn --arg t "$TENANT" --arg e "$TENANT_ENV" --arg ip "$MY_IP" --arg db "$DB_PASSWORD" \
  --arg jwt "$JWT_SECRET" --arg mail "$ADMIN_EMAIL" --arg adm "$ADMIN_PASSWORD" \
  '{tenant_id:$t, env:$e, plan:"basic", institution_name:("Institución " + $t), timezone:"America/La_Paz",
    limits:{max_students:100, max_teachers:10, max_courses:20}, db_host:$ip, db_password:$db,
    jwt_secret:$jwt, admin_email:$mail, admin_password:$adm, ssm_prefix:("/tenants/" + $t + "/" + $e)}')
cd /src/ansible
ANSIBLE_CONFIG=/src/ansible/ansible.cfg ANSIBLE_ROLES_PATH=/src/ansible/roles \
  ansible-playbook /test/boot-backend.yml -i /src/ansible/inventory.ini -e "$VARS" > /tmp/boot.log 2>&1 \
  || { tail -20 /tmp/boot.log; exit 1; }
echo "tenant $TENANT/$TENANT_ENV listo en $MY_IP"
