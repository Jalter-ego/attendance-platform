# Infraestructura compartida — P1, A5

Este bloque utiliza el bucket ya creado por `infra/bootstrap/`, con una clave de estado diferente: `platform/base/terraform.tfstate`.

Prepara:

- Una VPC con DNS, una subred pública y una privada en una misma zona de disponibilidad.
- Internet Gateway y una tabla de rutas pública; una tabla independiente para la subred privada.
- Security groups para el constructor de Packer y para el servidor de monitoreo.
- Rol/perfil de EC2 que permitirá a Prometheus descubrir instancias mediante consultas de lectura a AWS.
- Endpoint privado de Parameter Store (SSM), con HTTPS desde la VPC y lectura limitada a `/tenants/*`.
- Respaldos de P3: otro bucket S3 para dumps, endpoint gateway de S3, dos endpoints del agente SSM y tres políticas DLM para snapshots de datos.
- Una EC2 opcional de Prometheus/Grafana desde la AMI `monitoring` de P3, con administración por SSM.
- El output `integration`, con los IDs que usarán P2, P3, P5 y P6.

La EC2 de monitoreo se habilita con `monitoring`; sin ese bloque su valor es `null` y solo se crea la infraestructura compartida anterior. La imagen de P3 ya incluye Prometheus y Grafana; P5 aporta el descubrimiento de tenants, dashboards y alertas. Las tres EC2 de cada tenant tienen otro módulo y otro estado.

## Cuenta AWS y acceso a servidores

Los permisos de las cuentas del equipo ya los resolvió el responsable del proyecto con acceso administrador. Este Terraform no crea ni modifica esos usuarios.

`operator_cidrs` controla otra cosa: desde qué conexiones se acepta entrar por red a las EC2. Packer necesitará SSH (22) al constructor temporal, y el navegador necesitará el puerto de Grafana (3000). La IP que se configura es la pública de la conexión de quien accede, no la IP privada del equipo ni la de la EC2.

Una dirección seguida de `/32` autoriza esa IP IPv4. Se pueden añadir varias. Si cambia la IP de la conexión, se actualiza la lista y se vuelve a aplicar esta base.

Por decisión del responsable, inicialmente se mantiene `operator_cidrs = []`. La red puede crearse, pero el acceso entrante SSH/Grafana queda cerrado. P3 debe esperar a configurar las IPs antes de usar el SG de Packer con el comunicador SSH.

El perfil IAM de monitoreo es la identidad del software que correrá en EC2; no es otro usuario para los compañeros. Permite `DescribeInstances` y `DescribeAvailabilityZones`, que utiliza Prometheus para descubrimiento.

## Antes de aplicar

Desde la raíz del repositorio:

```bash
export AWS_PROFILE=attendance-terraform
aws sts get-caller-identity

mkdir -p .local
cp infra/terraform/base/terraform.tfvars.example .local/base.tfvars
cp infra/terraform/base/base.backend.hcl.example .local/base.backend.hcl
```

Si esos archivos locales ya existen, revísalos sin sobrescribirlos. `.local/base.backend.hcl` debe apuntar al mismo bucket y región del bootstrap, pero con `key = "platform/base/terraform.tfstate"`. Mantén `encrypt=true` y `use_lockfile=true`.

Revisa `.local/base.tfvars`. El CIDR inicial es `10.90.0.0/16`, con subredes `10.90.1.0/24` y `10.90.2.0/24`; cámbialo si debe convivir con otra red que use ese rango. La región es `us-east-2` en el ejemplo.

## Crear la base

```bash
terraform -chdir=infra/terraform/base init -backend-config=../../../.local/base.backend.hcl
terraform -chdir=infra/terraform/base fmt -check
terraform -chdir=infra/terraform/base validate
terraform -chdir=infra/terraform/base plan -var-file=../../../.local/base.tfvars -out=../../../.local/base.tfplan
terraform -chdir=infra/terraform/base apply ../../../.local/base.tfplan
terraform -chdir=infra/terraform/base output -json integration > .local/base.outputs.json
```

Revisa el plan antes de aplicar. Sin `monitoring` no se crea ninguna EC2; al habilitarlo se añade una instancia compartida. No hay NAT Gateway. Con la extensión de respaldos hay tres endpoints Interface (`ssm`, `ec2messages`, `ssmmessages`), con [costo por hora y tráfico](https://aws.amazon.com/privatelink/pricing/) compartido entre los tenants, además del endpoint gateway de S3.

Si ya creaste la base anterior, genera un plan nuevo con este código. Debe añadir el SG de SSM, su regla HTTPS y el endpoint, sin reemplazar la VPC/subredes. No reutilices el plan anterior. Después de aplicarlo, vuelve a exportar `integration`: ahora incluye `ssm_endpoint_id`.

## Habilitar la EC2 de monitoreo

En `.local/base.tfvars`, conserva la configuración actual y añade el bloque con el ID de `ami.monitoring` en `infra/packer/ami-ids.json`. Para el conjunto 0.2.2 en `us-east-2`:

```hcl
monitoring = {
  ami_id              = "ami-05292ee00805baf20"
  instance_type       = "t3.small"
  root_volume_size_gb = 20
}
```

El módulo valida que la AMI esté disponible, pertenezca a la cuenta y tenga `Role=monitoring`, arquitectura x86_64 y raíz EBS. Su ID queda fijado: publicar otra AMI no cambia esta instancia automáticamente. El tamaño predeterminado es `t3.small`, con disco gp3 cifrado de 20 GiB e IMDSv2. Los créditos de CPU usan modo `standard`; al agotarlos baja el rendimiento a la línea base en lugar de usar créditos excedentes de modo unlimited. Ver [el modo standard de AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-standard-mode.html).

La EC2 usa la subred pública y solicita IP pública para consultar la API de AWS. Reutiliza el SG y el perfil IAM de monitoreo. El arranque habilita Prometheus, Grafana y el agente SSM que ya vienen instalados; no descarga paquetes ni ejecuta la plantilla de un tenant. Se añade una política del agente, sin lectura de secretos de Parameter Store, para que P5 pueda configurarla con Run Command. La identidad que envía los comandos necesita sus propios permisos de operador.

Desde la raíz del repositorio:

```bash
export AWS_PROFILE=attendance-terraform
terraform -chdir=infra/terraform/base plan -input=false -lock-timeout=5m -var-file=../../../.local/base.tfvars -out=../../../.local/base-monitoring.tfplan
python3 infra/terraform/plan_preview.py --directory infra/terraform/base --plan .local/base-monitoring.tfplan
terraform -chdir=infra/terraform/base apply -lock-timeout=5m ../../../.local/base-monitoring.tfplan
terraform -chdir=infra/terraform/base output -json integration > .local/base.outputs.json
```

Sobre la base anterior ya aplicada, y sin modificar `operator_cidrs`, el plan debe añadir **una EC2 y una política IAM**, sin reemplazar la red ni recursos existentes. Aplicarlo inicia el uso facturable de EC2, EBS e IP pública. Revisa el plan nuevo antes de aplicar; los planes de respaldos anteriores no incluyen esta instancia.

Comparte este mismo bloque con quien aplique la base: todos administran el mismo estado. Quitar `monitoring` o ponerlo en `null` después de crearla planifica eliminar la EC2 y su disco. Cambiar AMI/cloud-init puede reemplazarla y perder el historial de métricas del disco raíz; dashboards y configuración deben quedar en código con P5.

`integration` añade `monitoring_instance_id`, `monitoring_private_ip`, `monitoring_public_ip` y `grafana_url`; sin instancia son `null`. La URL será `http://<ip-publica>:3000`. Con `operator_cidrs=[]` el acceso de red a Grafana sigue cerrado aunque exista una URL: añade las IPs autorizadas al aplicar la base cuando el equipo vaya a usarlo. No se abre Prometheus (9090) a Internet. Una parada/arranque puede cambiar la IP; vuelve a consultar los outputs.

P5 recibe ese archivo y configura el descubrimiento EC2 por etiquetas, los scrapes, el datasource local `http://127.0.0.1:9090`, dashboards y alertas. La AMI solo trae una configuración inicial de Prometheus que se consulta a sí mismo; crear la EC2 no significa que ya se estén monitoreando los tenants. Después del apply, comprobar SSM `Online`, servicios y salud de Grafana/Prometheus antes de dar A5/P5 por integrado.

Grafana tiene su propio login: el primer acceso es con usuario `admin` y contraseña `admin`, y solicita cambiarla. Si otro integrante ya la cambió, se usa esa contraseña; no son las credenciales del login de la plataforma. Ver [el acceso inicial documentado por Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/sign-in-to-grafana/).

Verificación del 14/11/2026: plan revisado de 2 altas, 0 modificaciones y 0 eliminaciones aplicado; agente SSM Online, cloud-init terminado, Prometheus ready y Grafana con database=ok comprobados dentro de la EC2. El plan posterior dio No changes. Falta configurar observabilidad con P5 y autorizar las IPs de acceso; los outputs locales ya están actualizados.

## Actualización de respaldos (PR #5)

El PR #5 ya está fusionado. Sobre la base con el endpoint SSM creado, la revisión dio **14 por crear, 1 por modificar y 0 por destruir**. Se añade el bucket `attendance-platform-backups-<cuenta>` (diferente del bucket de estado), sus protecciones/retención, el acceso privado a S3, dos endpoints del agente y las políticas de snapshots. La modificación amplía la política del endpoint SSM para el agente, conservando el límite de lectura de secretos por prefijo.

Desde la raíz del repositorio:

```bash
export AWS_PROFILE=attendance-terraform
terraform -chdir=infra/terraform/base plan -input=false -lock-timeout=5m -var-file=../../../.local/base.tfvars -out=../../../.local/base-backups.tfplan
terraform -chdir=infra/terraform/base show ../../../.local/base-backups.tfplan
terraform -chdir=infra/terraform/base apply -lock-timeout=5m ../../../.local/base-backups.tfplan
terraform -chdir=infra/terraform/base output -json integration > .local/base.outputs.json
```

Revisar los recursos y permisos, además de los totales. Solo una persona ejecuta `apply`; los demás esperan a que termine. Si el código o el estado cambian, se genera un plan nuevo. El plan guardado inicialmente para revisión, `.local/base-backups-review.tfplan`, corresponde al PR antes del ajuste de aislamiento y no debe usarse para aplicar esa corrección.

DLM selecciona volúmenes por una única etiqueta compuesta: `BackupPolicy=attendance-platform:weekly-28d` (o `daily-14d` / `daily-30d`). El módulo tenant usa el mismo formato. Añadir otra etiqueta `Project` al selector no serviría como filtro conjunto: [DLM combina las etiquetas de destino con OR](https://docs.aws.amazon.com/ebs/latest/userguide/dlm-elements.html#dlm-target-tags).

Aplicar la base prepara la infraestructura de respaldos. P3 ya publicó el conjunto 0.2.2 y reportó respaldo/restauración satisfactorios, también desde la plataforma. Usar los IDs de `infra/packer/ami-ids.json` al crear instalaciones nuevas; publicar otra AMI no exige volver a aplicar esta base. RF-19 sigue siendo opcional; `base.backups_bucket=""` en el tenant desactiva sus permisos de respaldos y actualización por S3/SSM.

La última orden guarda los IDs, sin credenciales, en un archivo local que puedes compartir con quienes integran Packer, los adaptadores y el worker. Los otros clones inicializan este mismo backend antes de planificar; no crean una red nueva por persona.

## Qué necesita P3

Desde `integration` obtiene `region`, `vpc_id`, `public_subnet_id` y `packer_security_group_id`. Su configuración de Packer debe solicitar una IP pública para el constructor temporal (`associate_public_ip_address = true`): la subred no la asigna automáticamente. El usuario y la clave del comunicador los configura P3 según la AMI de origen.

Antes del primer build SSH, P1 debe añadir las IPs públicas autorizadas a `operator_cidrs` y aplicar la base. Este paso está pendiente por acuerdo del equipo.

## Conectividad de backend y BD privados

La subred privada no tiene salida a Internet. El endpoint `com.amazonaws.<region>.ssm`, con DNS privado, permite que AWS CLI lea Parameter Store desde backend/BD. Las AMIs de P3 deben traer todo instalado; este acceso no permite descargar paquetes ni repositorios durante el primer arranque.

La lectura de parámetros usa la clave administrada `alias/aws/ssm`. La extensión de respaldos añade los canales del agente y permisos en la EC2 DB para Run Command; P3 reportó su funcionamiento con las AMIs actuales. El módulo tenant también prepara esos permisos de agente y lectura de releases en frontend/backend para P4. Una clave KMS propia necesitaría permisos adicionales. El SG permite HTTPS dentro de la VPC y las políticas IAM por tenant limitan qué parámetros puede leer cada EC2.

Las reglas de backend→BD y de monitoreo→exporters serán SG propios por tenant, definidos en el siguiente módulo. Compartir VPC/subredes no sustituye ese aislamiento.

## Pruebas locales sin AWS

```bash
terraform -chdir=infra/terraform/base init -backend=false
terraform -chdir=infra/terraform/base validate
terraform -chdir=infra/terraform/base test
```

Las once pruebas simulan AWS. Revisan DNS, separación de subredes/rutas, accesos cerrados por defecto, autorización de IPs concretas, permisos de descubrimiento de Prometheus, acceso privado a Parameter Store y aislamiento de respaldos. También cubren la EC2 de monitoreo, arranque, cifrado/IMDSv2, permisos del agente sin secretos, outputs y rechazo de AMI/tamaño/disco incompatibles. No prueban conectividad real ni crean recursos en AWS.

Referencias: [Internet Gateway y subredes](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html), [conectividad privada de SSM](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html), [descubrimiento EC2 de Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#ec2_sd_config).
