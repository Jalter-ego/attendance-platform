# Instalación por tenant — P1, C1/C2

Este directorio es el módulo raíz que ejecutarán Terraform/OpenTofu por cada instalación. Crea tres EC2 desde las AMIs de P3, tres SG, perfiles IAM y un EBS cifrado para PostgreSQL. Reutiliza la red base y tiene su propio estado; no crea otra VPC ni otro bucket.

El frontend publica HTTP y reenvía `/core/` a la API privada. La API solo admite el SG del frontend y el monitoreo; PostgreSQL solo admite el backend del mismo tenant. Los cuatro exporters de cada EC2 solo admiten el SG compartido de monitoreo. No se abre SSH en las EC2 del tenant.

## Antes de probar en AWS

1. Actualizar la [base](../base/README.md) para crear el endpoint privado SSM y volver a exportar `.local/base.outputs.json`.
2. Integrar el PR probado de P3, que aporta `infra/cloud-init/user-data.yaml.tftpl`, `attendance-boot` y los playbooks horneados. Este módulo consume ese contrato; no instala la aplicación ni sustituye el trabajo de P3/P4.
3. Tener los IDs concretos de las AMIs `frontend`, `backend`, `db`, disponibles en la misma cuenta/región y con la etiqueta `Role` correcta. No se selecciona una AMI nueva automáticamente.
4. Crear fuera de Terraform los `SecureString` de este tenant con la clave administrada de SSM. P6 automatizará su creación:

| Parámetro | Valor requerido por el arranque actual de P3 |
| --- | --- |
| `/tenants/san-marcos/test/db_password` | Aleatorio, alfanumérico, al menos 16 caracteres |
| `/tenants/san-marcos/test/jwt_secret` | Aleatorio, alfanumérico, al menos 32 caracteres |
| `/tenants/san-marcos/test/admin_password` | Aleatorio, alfanumérico, 12–72 caracteres; necesario para tener administrador inicial |

No pases esos valores como variables de Terraform: terminarían en el estado. Backend y DB pueden leer el prefijo de su tenant/entorno; frontend no tiene permiso para leer secretos. En esta versión ambos lectores comparten ese prefijo, como utiliza el script de P3.

## Preparar las variables

Desde la raíz del repositorio y con el perfil AWS autorizado:

```bash
export AWS_PROFILE=attendance-terraform
mkdir -p .local
python3 - <<'PY'
import json
from pathlib import Path

source = json.loads(Path("docs/examples/tenant.example.json").read_text())
fields = ("tenant_id", "name", "env", "plan", "engine", "contact_email", "timezone", "sizing", "ami")
config = {field: source[field] for field in fields}
config["base"] = json.loads(Path(".local/base.outputs.json").read_text())
Path(".local/san-marcos.tfvars.json").write_text(json.dumps(config, indent=2) + "\n")
PY
cp infra/terraform/tenant/tenant.backend.hcl.example .local/san-marcos.backend.hcl
```

Esos comandos crean archivos de ejemplo; si ya existen, revísalos sin sobrescribirlos. Cambia las tres AMIs ficticias por las reales y confirma nombre, correo y tamaños en `.local/san-marcos.tfvars.json`. Los tamaños iniciales admitidos son `t3.micro/small/medium/large`, compatibles con las AMIs x86_64 y el montaje NVMe de P3; P4 debe mantener su catálogo dentro de esta selección o coordinar su ampliación. Cada disco raíz tiene 12 GiB, como las imágenes actuales; el EBS de datos se dimensiona con `db_disk_gb`.

En `.local/san-marcos.backend.hcl`, coloca el bucket compartido y conserva:

```hcl
key          = "tenants/san-marcos/test/terraform.tfstate"
region       = "us-east-2"
encrypt      = true
use_lockfile = true
```

El `tenant_id` y `env` de esa clave deben coincidir con las variables. Nunca uses las claves del bootstrap, de la base ni de otro cliente. Mantén el workspace `default`.

## Planificar y crear

Ejecutar cuando se cumplan los requisitos anteriores:

```bash
terraform -chdir=infra/terraform/tenant init -backend-config=../../../.local/san-marcos.backend.hcl
terraform -chdir=infra/terraform/tenant validate
terraform -chdir=infra/terraform/tenant plan -lock-timeout=5m -var-file=../../../.local/san-marcos.tfvars.json -out=../../../.local/san-marcos.tfplan
terraform -chdir=infra/terraform/tenant show ../../../.local/san-marcos.tfplan
terraform -chdir=infra/terraform/tenant apply -lock-timeout=5m ../../../.local/san-marcos.tfplan
terraform -chdir=infra/terraform/tenant output -json > .local/san-marcos.outputs.json
```

El orden es EBS → EC2 DB → adjuntar EBS → backend → frontend. Cloud-init de DB espera el disco; el backend espera la BD. `Apply complete` confirma infraestructura, no el final de Ansible. Comprueba las dos URLs `frontend_health` y `backend_health` antes de marcar el tenant como listo. El estado detallado de P3 queda en `/var/lib/attendance/boot.json` y `/var/log/attendance-boot.log` dentro de la VM; este módulo aún no habilita lectura remota vía Session Manager.

P2/P6 deben usar un directorio de ejecución independiente por tenant/entorno y mantener accesibles la plantilla cloud-init y su ruta. No cambiar el backend de un directorio mientras se ejecuta otra operación. La opción `cloud_init_template_path` permite indicar la ubicación de la plantilla cuando el worker prepara su directorio. La cola de P6 evita operaciones simultáneas y el bloqueo S3 protege el estado.

Si falla una creación, conserva el backend, las variables y los secretos. Ejecuta otro `plan` sobre el mismo estado para completar lo pendiente; no crees otra clave ni borres el lock de una operación activa. Un plan guardado anterior puede quedar obsoleto tras cambios de otro participante.

## Discos y eliminación

El EBS de datos es un recurso separado: se conserva al reemplazar la EC2 DB y se desacopla deteniendo la instancia, sin forzar. Cambiar la AMI o el cloud-init puede reemplazar EC2 e IPs; no se ha probado aún una actualización con datos reales.

`destroy` del tenant elimina las tres EC2, sus discos raíz **y el EBS de datos**. La vista previa debe mostrarlo al usuario; la red compartida y el bucket se conservan. Para preparar esa revisión:

```bash
terraform -chdir=infra/terraform/tenant plan -destroy -lock-timeout=5m -var-file=../../../.local/san-marcos.tfvars.json -out=../../../.local/san-marcos-destroy.tfplan
terraform -chdir=infra/terraform/tenant show ../../../.local/san-marcos-destroy.tfplan
```

Este bloque no implementa todavía suspensión/reanudación, cambios de plan, servidor de monitoreo ni interfaz de la plataforma. OpenTofu usará el mismo código, con `engine="tofu"` y su backend propio por despliegue; la ejecución con ese CLI está pendiente de verificar. No alternes motores sobre una instalación existente sin una migración acordada.

## Verificación sin desplegar

```bash
terraform -chdir=infra/terraform/tenant init -backend=false
terraform -chdir=infra/terraform/tenant validate
terraform -chdir=infra/terraform/tenant test
```

Seis pruebas con AWS simulado verifican aislamiento de red/IAM, datos de cloud-init y EBS, outputs y rechazo de plantilla ausente, arquitectura incompatible, otra VPC o DNS privado desactivado. La fixture de cloud-init solo verifica el contrato y no arranca Attendance. Todavía falta la prueba real con AMIs, secretos y health checks.
