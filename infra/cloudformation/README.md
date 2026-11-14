# Instalación por tenant con CloudFormation — P2, D4/D5

`tenant.yaml` crea el **mismo stack** que [`infra/terraform/tenant`](../terraform/tenant/README.md), para los tenants registrados con `engine=cloudformation`. La plataforma lo ejecuta con el adaptador `platform/platform_api/src/engines/cloudformation.js`, así que no hace falta lanzarlo a mano.

## Qué crea (un stack por tenant y entorno)

Nombre del stack: `<project_name>-<tenant_id>-<env>`, por ejemplo `attendance-platform-san-marcos-test`.

| Recurso | Detalle |
| --- | --- |
| 3 EC2 | Frontend (subred pública, IP pública), backend y base de datos (subred privada), desde las AMIs de Packer. IMDSv2 obligatorio y disco raíz gp3 cifrado de 12 GiB, aplicados con un `LaunchTemplate` compartido. |
| EBS de datos | gp3 cifrado del tamaño del plan, adjuntado en `/dev/sdf`. Lleva la etiqueta `BackupPolicy` de DLM si hay bucket de respaldos. |
| 3 grupos de seguridad | Las mismas reglas que Terraform: HTTP 80 al frontend; API 5000 solo desde el frontend y el monitoreo; PostgreSQL 5432 solo desde el backend; exporters 9100/9256/8889/19999 solo desde el SG de monitoreo. |
| IAM | Un rol y un perfil por servidor. Backend y db leen solo `/tenants/<id>/<env>/*` en SSM; el frontend no lee secretos. Con bucket de respaldos se agregan las acciones del agente SSM, la lectura de `releases/` (frontend y backend) y `db/` (base de datos). No se usa `AmazonSSMManagedInstanceCore`. |
| User data | Replica `infra/cloud-init/user-data.yaml.tftpl`: escribe `/etc/attendance/tenant.json` y ejecuta `attendance-boot` (horneado en la AMI), que lee SSM y corre Ansible. |

Orden: EBS → db → adjuntar disco → backend (con la IP privada de db) → frontend (con la IP privada del backend). Las etiquetas `Project`, `Tenant`, `Env`, `Plan` y `ManagedBy=cloudformation` se aplican al stack y CloudFormation las propaga. Cada recurso lleva además `Role`, así que Prometheus los descubre igual que a los de Terraform.

## Cómo lo ejecuta la plataforma

| Operación | Qué hace el adaptador |
| --- | --- |
| `create` | Valida las AMIs (disponibles y con etiqueta `Role`) y lee el CIDR de la VPC. Crea un **change set** (`CREATE` o `UPDATE`) y lo revisa: si eliminaría o reemplazaría el disco de datos, lo descarta. Lo ejecuta, sigue los eventos del stack y lee los outputs. |
| `suspend` / `resume` | **D5:** CloudFormation no puede detener instancias de forma declarativa. Por eso el adaptador llama a `StopInstances` y `StartInstances` de EC2 sobre las instancias del stack. Los discos se conservan. Al reanudar, la IP pública se consulta otra vez en EC2. |
| `destroy` | `DeleteStack` y seguimiento de eventos. Elimina las EC2, sus discos **y el EBS de datos**. |
| vista previa | `preview()` crea un change set y lo descarta, o lista los recursos del stack si se va a eliminar. |

El reintento es idempotente:

- Sin cambios, el change set se descarta y no se ejecuta.
- Una creación fallida deja el stack en `ROLLBACK_COMPLETE`, sin recursos. El reintento lo elimina y crea uno nuevo.
- Si el stack sigue en curso, por ejemplo porque se canceló desde la plataforma, se espera a que AWS termine antes de continuar.

## Estado y su protección (A6)

- **El estado lo administra AWS:** es el propio stack. No hay archivo de estado, bucket ni bloqueo propio. CloudFormation no admite dos operaciones a la vez sobre el mismo stack, y la cola de la plataforma tampoco permite dos operaciones del mismo tenant.
- **Secretos:** no pasan por la plantilla. El adaptador solo envía nombres, IDs y tamaños; las contraseñas viven en SSM (`/tenants/<id>/<env>/`). La identidad de cloud-init (`BootIdentityJson`) no contiene secretos.
- **Cancelación:** cancelar en la plataforma deja de seguir el stack, pero **la operación continúa en AWS**. Un reintento espera a que termine y retoma desde ese estado. También se espera un stack estable antes de detener o arrancar EC2.
- **Tiempo máximo:** `IAC_TIMEOUT_S` (3600 segundos por defecto) limita sondeos y peticiones SDK; al agotarse se deja de esperar, sin ordenar una eliminación remota.
- **Seguimiento:** cada ejecución/eliminación usa `ClientRequestToken` y solo se confirma con el evento raíz de esa operación. Así un `COMPLETE` anterior no publica un resultado prematuro. Ver [StackEvent de AWS](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_StackEvent.html). La creación solicita rollback explícitamente; cancelar el seguimiento no inicia un rollback.
- **Integración P6:** no exige `IAC_STATE_BUCKET`/`DEPLOYMENT_STATE_BUCKET` ni escribe `backend.hcl` o `tenant.tfvars.json`. Guarda el nombre/ARN del stack, la versión del SDK y el hash de plantilla. El bucket de respaldos de la base es independiente de este estado.

## Permisos del worker

Además de los de SSM:

- `cloudformation:*Stack*` y `cloudformation:*ChangeSet*` sobre los stacks del proyecto.
- En EC2: `DescribeImages`, `DescribeVpcs`, `DescribeInstances`, `StopInstances` y `StartInstances`, y los permisos para crear y eliminar instancias, volúmenes, SG y plantillas de lanzamiento.
- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:CreateInstanceProfile`, `iam:AddRoleToInstanceProfile`, `iam:PassRole` y sus equivalentes de eliminación.
- `CAPABILITY_IAM`: la plantilla crea roles sin nombre fijo.

## Probar la plantilla

```bash
pip install cfn-lint
cfn-lint --regions us-east-2 -- infra/cloudformation/tenant.yaml
aws cloudformation validate-template --template-body file://infra/cloudformation/tenant.yaml
cd platform/platform_api && pnpm test:cloudformation   # adaptador con AWS simulado
```

Despliegue manual opcional, sin la plataforma. Requiere los outputs de la base y que los secretos de SSM ya existan:

```bash
aws cloudformation deploy --region us-east-2 \
  --stack-name attendance-platform-prueba-test \
  --template-file infra/cloudformation/tenant.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ProjectName=attendance-platform TenantId=prueba Env=test ... \
  --tags Project=attendance-platform Tenant=prueba Env=test ManagedBy=cloudformation
```

Elimina el stack al terminar las pruebas (`aws cloudformation delete-stack`): borra también el disco de datos.
