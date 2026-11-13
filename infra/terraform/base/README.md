# Red compartida — P1, A5

Este bloque utiliza el bucket ya creado por `infra/bootstrap/`, con una clave de estado diferente: `platform/base/terraform.tfstate`.

Prepara:

- Una VPC con DNS, una subred pública y una privada en una misma zona de disponibilidad.
- Internet Gateway y una tabla de rutas pública; una tabla independiente para la subred privada.
- Security groups para el constructor de Packer y para el futuro servidor de monitoreo.
- Rol/perfil de EC2 que permitirá a Prometheus descubrir instancias mediante consultas de lectura a AWS.
- Endpoint privado de Parameter Store (SSM), con HTTPS desde la VPC y lectura limitada a `/tenants/*`.
- Respaldos de P3: otro bucket S3 para dumps, endpoint gateway de S3, dos endpoints del agente SSM y tres políticas DLM para snapshots de datos.
- El output `integration`, con los IDs que usarán P2, P3, P5 y P6.

La EC2 de monitoreo se creará después, cuando P3 entregue su AMI y P5 tenga su configuración. Las tres EC2 de cada tenant tendrán otro módulo y otro estado. Por eso A5 queda parcialmente implementado en este bloque.

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

Revisa el plan antes de aplicar. Este bloque no contiene instancias ni NAT Gateway. Con la extensión de respaldos hay tres endpoints Interface (`ssm`, `ec2messages`, `ssmmessages`), con [costo por hora y tráfico](https://aws.amazon.com/privatelink/pricing/) compartido entre los tenants, además del endpoint gateway de S3.

Si ya creaste la base anterior, genera un plan nuevo con este código. Debe añadir el SG de SSM, su regla HTTPS y el endpoint, sin reemplazar la VPC/subredes. No reutilices el plan anterior. Después de aplicarlo, vuelve a exportar `integration`: ahora incluye `ssm_endpoint_id`.

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

Aplicar la base prepara la infraestructura de respaldos. P3 todavía debe publicar la AMI de BD 0.2.0 con los scripts y el arranque actualizados, y probar respaldo/restauración. Las AMIs 0.1.2 registradas no incluyen esa extensión. RF-19 sigue siendo opcional; para probar solo Attendance con 0.1.2, el tenant puede mantener `base.backups_bucket=""`.

La última orden guarda los IDs, sin credenciales, en un archivo local que puedes compartir con quienes integran Packer, los adaptadores y el worker. Los otros clones inicializan este mismo backend antes de planificar; no crean una red nueva por persona.

## Qué necesita P3

Desde `integration` obtiene `region`, `vpc_id`, `public_subnet_id` y `packer_security_group_id`. Su configuración de Packer debe solicitar una IP pública para el constructor temporal (`associate_public_ip_address = true`): la subred no la asigna automáticamente. El usuario y la clave del comunicador los configura P3 según la AMI de origen.

Antes del primer build SSH, P1 debe añadir las IPs públicas autorizadas a `operator_cidrs` y aplicar la base. Este paso está pendiente por acuerdo del equipo.

## Conectividad de backend y BD privados

La subred privada no tiene salida a Internet. El endpoint `com.amazonaws.<region>.ssm`, con DNS privado, permite que AWS CLI lea Parameter Store desde backend/BD. Las AMIs de P3 deben traer todo instalado; este acceso no permite descargar paquetes ni repositorios durante el primer arranque.

La lectura de parámetros usa la clave administrada `alias/aws/ssm`. La extensión de respaldos añade los canales del agente y permisos en la EC2 DB para Run Command; su funcionamiento se verificará con la nueva AMI de P3. Una clave KMS propia necesitaría permisos adicionales. El SG permite HTTPS dentro de la VPC y las políticas IAM por tenant limitan qué parámetros puede leer cada EC2.

Las reglas de backend→BD y de monitoreo→exporters serán SG propios por tenant, definidos en el siguiente módulo. Compartir VPC/subredes no sustituye ese aislamiento.

## Pruebas locales sin AWS

```bash
terraform -chdir=infra/terraform/base init -backend=false
terraform -chdir=infra/terraform/base validate
terraform -chdir=infra/terraform/base test
```

Las seis pruebas simulan AWS. Revisan DNS, separación de subredes/rutas, accesos cerrados por defecto, autorización de IPs concretas, permisos de descubrimiento de Prometheus, acceso privado a Parameter Store y aislamiento de respaldos. No prueban conectividad real ni crean la VPC.

Referencias: [Internet Gateway y subredes](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html), [conectividad privada de SSM](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html), [descubrimiento EC2 de Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#ec2_sd_config).
