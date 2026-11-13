# Red compartida — P1, A5

Este bloque utiliza el bucket ya creado por `infra/bootstrap/`, con una clave de estado diferente: `platform/base/terraform.tfstate`.

Prepara:

- Una VPC con DNS, una subred pública y una privada en una misma zona de disponibilidad.
- Internet Gateway y una tabla de rutas pública; una tabla independiente para la subred privada.
- Security groups para el constructor de Packer y para el futuro servidor de monitoreo.
- Rol/perfil de EC2 que permitirá a Prometheus descubrir instancias mediante consultas de lectura a AWS.
- Endpoint privado de Parameter Store (SSM), con HTTPS desde la VPC y lectura limitada a `/tenants/*`.
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

Revisa el plan antes de aplicar. El resultado contiene red, SG, rol/perfil de monitoreo y un endpoint privado SSM; no contiene instancias ni NAT Gateway. El endpoint tiene [costo por hora y tráfico](https://aws.amazon.com/privatelink/pricing/), compartido entre los tenants.

Si ya creaste la base anterior, genera un plan nuevo con este código. Debe añadir el SG de SSM, su regla HTTPS y el endpoint, sin reemplazar la VPC/subredes. No reutilices el plan anterior. Después de aplicarlo, vuelve a exportar `integration`: ahora incluye `ssm_endpoint_id`.

La última orden guarda los IDs, sin credenciales, en un archivo local que puedes compartir con quienes integran Packer, los adaptadores y el worker. Los otros clones inicializan este mismo backend antes de planificar; no crean una red nueva por persona.

## Qué necesita P3

Desde `integration` obtiene `region`, `vpc_id`, `public_subnet_id` y `packer_security_group_id`. Su configuración de Packer debe solicitar una IP pública para el constructor temporal (`associate_public_ip_address = true`): la subred no la asigna automáticamente. El usuario y la clave del comunicador los configura P3 según la AMI de origen.

Antes del primer build SSH, P1 debe añadir las IPs públicas autorizadas a `operator_cidrs` y aplicar la base. Este paso está pendiente por acuerdo del equipo.

## Conectividad de backend y BD privados

La subred privada no tiene salida a Internet. El endpoint `com.amazonaws.<region>.ssm`, con DNS privado, permite que AWS CLI lea Parameter Store desde backend/BD. Las AMIs de P3 deben traer todo instalado; este acceso no permite descargar paquetes ni repositorios durante el primer arranque.

Este bloque cubre lectura de parámetros, con la clave administrada `alias/aws/ssm`. Session Manager/Run Command requieren ampliar endpoints, permisos y configuración del agente; todavía no se incluyen. Una clave KMS propia también necesitaría permisos adicionales. El SG permite HTTPS dentro de la VPC y las políticas IAM por tenant limitan qué parámetros puede leer cada EC2.

Las reglas de backend→BD y de monitoreo→exporters serán SG propios por tenant, definidos en el siguiente módulo. Compartir VPC/subredes no sustituye ese aislamiento.

## Pruebas locales sin AWS

```bash
terraform -chdir=infra/terraform/base init -backend=false
terraform -chdir=infra/terraform/base validate
terraform -chdir=infra/terraform/base test
```

Las cinco pruebas simulan AWS. Revisan DNS, separación de subredes/rutas, accesos cerrados por defecto, autorización de IPs concretas, permisos de descubrimiento de Prometheus y acceso privado a Parameter Store. No prueban conectividad real ni crean la VPC.

Referencias: [Internet Gateway y subredes](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html), [conectividad privada de SSM](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html), [descubrimiento EC2 de Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#ec2_sd_config).
