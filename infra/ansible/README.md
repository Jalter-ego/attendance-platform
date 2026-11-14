# Ansible de las VMs del tenant — P3 / P4

Ansible corre **dentro de cada VM**, en modo local (`connection: local`), nunca por SSH desde la plataforma. Hay tres momentos, cada uno con su playbook:

| Playbook | Cuándo | Quién lo lanza | Roles |
|---|---|---|---|
| `image.yml` | Al hornear la AMI | Packer (`infra/packer`, P3) | `image_base`, `image_node`, `image_agents`, `image_backend`, `image_frontend`, `image_db`, `image_monitoring` |
| `boot.yml` | Primer arranque de cada VM | cloud-init → `attendance-boot` (`infra/cloud-init`, P3) | `boot_db`, `boot_backend`, `boot_frontend` |
| `update.yml` | Actualizar la app **sin recrear la VM** (E2 · RF-15) | `infra/app-update/tenant-update.sh` → SSM Run Command (P4) | `update_backend`, `update_frontend` |

```
group_vars/all.yml   versiones fijas (node, exporters), rutas, puertos, repos de la app
ansible.cfg          roles_path=roles, inventario = solo localhost
inventory.ini        localhost ansible_connection=local
roles/               image_* (Packer) · boot_* (cloud-init) · update_* (actualización)
tests/update/        pruebas locales con Docker de update.yml, tenant-update.sh y tenant-health.sh
```

## 1. Primer arranque (`boot.yml`)

Detalle del flujo y del contrato con el motor IaC en `infra/cloud-init/README.md`. Resumen:

```
cloud-init → /etc/attendance/tenant.json → attendance-boot → secretos de SSM → ansible-playbook boot.yml
  db       monta el EBS, PostgreSQL solo desde la VPC, usuario/base del tenant, respaldos
  backend  backend.env (secretos + PLAN_MAX_* del plan), espera la BD, migraciones, admin inicial,
           arranca la API y espera GET /core/api/v1/health = 200 (API conectada a SU BD)
  frontend nginx apunta al backend privado del tenant, /healthz
→ /var/lib/attendance/boot.json  {"status":"ready"|"failed", ...}
```

`boot_backend` traduce el `limits` del tenant a `PLAN_MAX_STUDENTS`, `PLAN_MAX_TEACHERS` y `PLAN_MAX_COURSES`, que `attendance-core` hace cumplir (E4 · RF-05). Un valor inválido impide arrancar la API, así que el boot queda `failed` en lugar de dejar un tenant sin límites.

> El cambio "esperar `/health` = 200" (antes aceptaba 200/401/404 en la raíz, que solo probaba que Node escuchaba) entra en la **próxima AMI**: los playbooks de `boot.yml` van horneados. Las AMIs 0.2.2 conservan la espera anterior.

## 2. Actualización de la app (`update.yml`)

Contrato completo con el worker de P6: `docs/contrato-actualizacion.md`.

```
build-release.sh (Linux)  →  <comp>-<sha12>.tar.gz + .sha256   (manifest.json · app/ · ansible/)
tenant-update.sh publish  →  s3://<bucket>/tenants/<id>/<env>/releases/
tenant-update.sh apply    →  Run Command: remote-apply.sh en la EC2
                               flock · descarga con el rol IAM de la VM · sha256 · extrae
                               ansible-playbook update.yml  (el que viene EN el paquete)
                               → /var/lib/attendance/update.json → JSON en la última línea
```

**`update.yml` no está horneado:** viaja dentro del paquete. Por eso funciona en las VMs que ya existen (AMI 0.2.2) sin rehornear ni recrear instancias.

| Paso | `update_backend` | `update_frontend` |
|---|---|---|
| Release | `/opt/attendance/releases/backend-<sha12>` (root:attendance, `o=`) | `/opt/attendance/releases/frontend-<sha12>`. La 1.ª vez guarda el build horneado como release y convierte `/var/www/attendance` en enlace |
| Antes del cambio | Migraciones con `backend.env`. Si fallan, no se toca nada | Comprueba que el paquete trae `index.html` |
| Cambio | `backend-current` → release nueva (`ln -sfn` + `mv -T`, atómico) | `/var/www/attendance` → release nueva (atómico), `nginx -t`, reload |
| Salud | `GET /core/api/v1/health` = 200 (hasta 90 s) | La portada servida = `index.html` del paquete |
| Si falla | Vuelve al enlace anterior, reinicia y comprueba → `rolled_back` | Vuelve al enlace anterior y recarga → `rolled_back` |
| Limpieza | Conserva las 3 releases más recientes; nunca la activa ni la anterior; borra las fallidas | Igual |

`status` del resultado: `succeeded` (versión nueva activa y sana) · `rolled_back` (la nueva falló, sigue la anterior) · `failed` (falló antes del cambio, o la vuelta atrás tampoco quedó sana).

**Volver atrás restaura el código, no la BD.** Las migraciones de `attendance-core` deben ser compatibles hacia atrás. Para el backend en `prod`, respaldar antes con `infra/backups/tenant-backup.sh backup`.

## 3. Health check del tenant (`infra/health/tenant-health.sh`, E6)

Lo usa el worker antes de marcar un tenant como listo (después de crear, reanudar o actualizar). Va por el nginx público: `/healthz` y `/core/api/v1/health` (nginx → API → PostgreSQL), con reintentos. Con `--boot` también lee `boot.json` de las 3 VMs por SSM. Formato del JSON en `docs/contrato-actualizacion.md` §8.

## 4. Pruebas locales (`tests/update/`, sin AWS)

Requieren Docker Desktop. Se lanzan desde Git Bash en la raíz del repo:

```bash
# Roles de actualización con una app falsa (10 comprobaciones, ~4 min)
bash infra/ansible/tests/update/run.sh

# Flujo completo con la app REAL (22 comprobaciones, ~5 min). Primero los paquetes:
docker run --rm -v "$(cygpath -m $PWD):/repo" -w /repo node:24-bookworm bash -c \
  'corepack enable; corepack prepare pnpm@10.11.0 --activate;
   bash infra/app-update/build-release.sh --component backend;
   bash infra/app-update/build-release.sh --component frontend'
bash infra/ansible/tests/update/e2e.sh
```

La "VM" es un contenedor Ubuntu 24.04 con systemd, nginx, ansible-core de apt (2.16, el de la AMI), Node 24.15.0 y PostgreSQL 16. `e2e.sh` cubre:

- `tenant-update.sh publish/apply/status` con los paquetes reales de core y web;
- migraciones reales;
- un backend roto que vuelve atrás;
- misma VM y datos conservados;
- `tenant-health.sh` en estos casos: sano, API caída (502), base caída (503) y recuperación;
- `boot_backend` esperando `/health`.

La AWS CLI la reemplaza `fake-aws.sh`: S3 es una carpeta local, Run Command es `docker exec` y responde con `\r\n` como la CLI de Windows del worker. Para entrar en la VM: `docker exec -it p4-e2 bash`.

Revisar la sintaxis con Ansible en WSL:

```bash
cd infra/ansible && ANSIBLE_CONFIG=ansible.cfg ansible-playbook update.yml --syntax-check -i localhost,
```
