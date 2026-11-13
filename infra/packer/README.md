# Imágenes (Packer) — P3

Packer construye **antes que nada** las 4 AMIs que usan todos los tenants. Es infraestructura
inmutable: una versión nueva de la app o de los agentes = AMIs nuevas = el motor IaC reemplaza
las VMs. Nada se instala "a mano" en una VM.

| AMI | Qué trae horneado |
|---|---|
| `attendance-frontend-*` | nginx + build de `attendance-web` (usa `/core/api/v1`, nginx lo reenvía al backend) |
| `attendance-backend-*` | Node 24 + pnpm + `attendance-core` compilado + servicio systemd (arranca cuando existe `backend.env`) |
| `attendance-db-*` | PostgreSQL 16 detenido (los datos van en un EBS que monta cloud-init) |
| `attendance-monitoring-*` | Prometheus + Grafana (configuración: P5) |
| **todas** | ansible-core, AWS CLI v2, node_exporter :9100, process_exporter :9256, OTel collector :8889, Netdata :19999, `attendance-boot` y los playbooks en `/opt/attendance/ansible` |

Base: Ubuntu 24.04 oficial de Canonical. Disco raíz cifrado, IMDSv2 obligatorio.

## Cómo funciona

```
packer build .
  └─ 4 builds en paralelo (frontend, backend, db, monitoring), misma fuente Ubuntu
       ├─ shell  scripts/install-ansible.sh         ansible-core + utilidades
       ├─ file   ../cloud-init/attendance-boot.sh → /usr/local/sbin/attendance-boot
       ├─ ansible-local  ../ansible/image.yml -e image_role=<rol>
       ├─ shell  scripts/cleanup.sh                 machine-id, llaves SSH, cloud-init clean
       └─ manifest → ami-manifest.json  →  scripts/ami_ids.py → ami-ids.json
```

Cada AMI lleva `/etc/attendance/image.json` con todas las versiones (app, commit, Node, agentes):
es lo que la plataforma registra por despliegue (RF-13).

## Comandos

Requisitos: Packer ≥ 1.11, credenciales AWS de la cuenta del equipo (perfil `default`).

```bash
cd infra/packer
packer init .
packer fmt -check .
packer validate .
packer build -var image_version=0.1.0 -var git_commit=$(git rev-parse --short HEAD) .
python scripts/ami_ids.py ami-manifest.json ami-ids.json

# Un solo rol (p. ej. tras cambiar el backend):
packer build -only='attendance.amazon-ebs.backend' -var image_version=0.1.1 .

# Otra versión de la app:
packer build -var backend_ref=develop -var frontend_ref=develop .
```

Con la red de P1 en lugar de la VPC por defecto (antes P1 debe agregar tu IP a `operator_cidrs`):

```bash
packer build -var subnet_id=<public_subnet_id> -var security_group_id=<packer_security_group_id> .
```

Con GNU make (Linux/WSL): `make packer-validate`, `make packer-build`, `make packer-build ONLY=backend`.

Costo: 4 instancias `t3.small` durante ~15-20 min por build + almacenamiento de las AMIs
(snapshots de 12 GB c/u). Borrar AMIs viejas: EC2 → AMIs → Deregister + borrar su snapshot.

## Para el IaC (B7, con P1)

Opción recomendada: buscar la AMI por etiquetas (no hay que copiar IDs):

```hcl
data "aws_ami" "role" {
  for_each    = toset(["frontend", "backend", "db"])
  owners      = ["self"]
  most_recent = true
  filter {
    name   = "tag:Project"
    values = ["attendance-platform"]   # la 0.1.0 se construyó con "attendance"
  }
  filter {
    name   = "tag:Role"
    values = [each.key]
  }
  filter {
    name   = "tag:ImageVersion"
    values = [var.image_version]   # fija la versión; "*" = la última
  }
}
```

Alternativa: leer `ami-ids.json` (`jsondecode(file(...)).ami.backend`), que también usa la
plataforma para la entrada `ami` del JSON de variables del tenant (§7 del plan).

El arranque de cada VM (user_data) está en [`../cloud-init/README.md`](../cloud-init/README.md).
