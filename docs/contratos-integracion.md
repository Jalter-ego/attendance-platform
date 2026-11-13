# Convenciones iniciales de integración

Propuesta de P1 para desarrollar las piezas en paralelo. Amplía la sección 7 del plan sin sustituirla. Los nombres de campos deben coordinarse con P2 (adaptadores), P3 (imágenes/cloud-init), P4 (app/planes) y P6 (API/worker) antes de cambiarse.

## Identidad y etiquetas

- Proyecto: `attendance-platform`.
- Región inicial de los ejemplos: `us-east-2`, configurable. No es una confirmación de disponibilidad, cuota ni acceso en AWS.
- `tenant_id`: identificador de la plataforma, en minúsculas, con letras, números y guiones; entre 3 y 40 caracteres, sin guion inicial/final.
- `env`: `test` o `prod`. El primer despliegue de integración será `test`.
- `engine`: `terraform`, `tofu`, `pulumi` o `cloudformation`. Se conserva durante la vida del despliegue; cambiarlo requiere una migración acordada, no ejecutar otro motor sobre los mismos recursos.
- `plan`: código estable que publica P4. Se propone `basic`, `standard`, `advanced`, manteniendo los tamaños como datos de entrada y no duplicando el catálogo en cada motor.

Etiquetas: `Project`, `Tenant`, `Env`, `Role`, `Plan`, `ManagedBy`. Los roles de las EC2 son `frontend`, `backend`, `db`; `monitoring` identifica el servidor compartido. Los recursos compartidos utilizan `Tenant=platform`.

Attendance sigue siendo una aplicación de una sola institución. `tenant_id` identifica recursos desde esta plataforma; no se vuelve a agregar como filtro de datos ni como campo del login del producto.

## Entrada y salida

[tenant.example.json](examples/tenant.example.json) muestra la entrada del despliegue. P6 valida la solicitud y P2 transforma estos datos en las variables o parámetros de cada motor. Los IDs de AMI son ficticios; P3 entregará los reales y su versión. Los tamaños y el disco son ejemplos, pendientes de confirmar por P4.

P1 entrega los IDs de VPC, subredes y SG desde `infra/terraform/base`, mediante `terraform output -json integration`. El contrato incluye `region`, `availability_zone`, `vpc_id`, `public_subnet_id`, `private_subnet_id`, `packer_security_group_id`, `monitoring_security_group_id`, `monitoring_instance_profile_name` y, en esta actualización, `ssm_endpoint_id`. Hay que aplicar el nuevo endpoint y volver a exportar el output. Son configuración interna del worker, no valores que el usuario de la plataforma deba escribir en el formulario.

El resultado de un adaptador debe contener:

```json
{
  "status": "succeeded",
  "resources": [],
  "outputs": {
    "urls": {},
    "instance_ids": {},
    "private_ips": {}
  },
  "tool_versions": {},
  "log_ref": "operations/ID"
}
```

P2 define el detalle de `resources` y las interfaces de los adaptadores; P6 define las rutas de la API y los estados de las operaciones. P1 no implementa esas capas en este bloque.

## Estado y concurrencia

Un bucket nuevo, propio de este proyecto, almacena estados separados:

| Uso | Clave o ubicación propuesta |
| --- | --- |
| Bootstrap del bucket | `platform/bootstrap/terraform.tfstate` |
| Red y recursos compartidos | `platform/base/terraform.tfstate` |
| Tenant con Terraform/OpenTofu | `tenants/<tenant_id>/<env>/terraform.tfstate` |
| Pulumi | Prefijo separado `pulumi/`; P2 configura stacks y cifrado de secretos |
| CloudFormation | Estado administrado por AWS; stack por tenant/entorno |

Para Terraform/OpenTofu se utiliza el workspace `default`; la separación se hace con `key` y un directorio de ejecución por tenant. P6 debe impedir dos operaciones simultáneas del mismo tenant, y el backend S3 debe tener `use_lockfile=true`. Son protecciones complementarias. Los adaptadores siempre deben usar bloqueo y esperar un tiempo acotado, nunca deshabilitarlo.

Terraform >= 1.10 y OpenTofu >= 1.10 admiten el bloqueo nativo de S3. El responsable confirmó que el equipo ya dispone de acceso administrador. Cada clon configura su perfil AWS autorizado; las credenciales y la configuración `.terraform/` se mantienen fuera del repositorio. Los perfiles IAM de las EC2 siguen siendo identidades de servicio distintas de las cuentas del equipo.

## Secretos y arranque

- Prefijo SSM por cliente: `/tenants/<tenant_id>/<env>/`.
- P6 genera los secretos y los escribe como `SecureString` mediante AWS SDK/CLI; el IaC recibe nombres/prefijos, no contraseñas ni valores del JWT.
- P1 creará perfiles IAM limitados al prefijo del cliente. P3/P4 leerán los parámetros al arrancar y escribirán los archivos de entorno con permisos restringidos.
- `INSTITUTION_NAME` e `INSTITUTION_TIMEZONE` configuran Attendance. Los secretos del backend y PostgreSQL nunca se escriben en `config.json` del frontend.
- `infra/terraform/tenant` consume la plantilla `infra/cloud-init/user-data.yaml.tftpl` del PR de P3: `role`, `tenant_id`, `env`, `plan`, `region`, `ssm_prefix`, `vpc_cidr`, `db_host`, `backend_host`, `db_volume_id`, `institution_name`, `timezone`, `admin_email`, `limits`. No se copia ni se sustituye esa plantilla desde P1.
- Si P2/P6 ejecutan una copia aislada del módulo o lo instalan mediante `source` absoluto, deben pasar `cloud_init_template_path` con una ruta absoluta al archivo del checkout. El valor por defecto requiere que se conserve la estructura del monorepo.
- Orden: EBS → DB → adjuntar disco → backend con IP privada de DB → frontend con IP privada de backend. El frontend usa nginx como proxy; API/DB no tienen IP pública. No se considera listo un tenant hasta superar los health checks de P4.
- Los tres IDs de AMI se fijan por despliegue; se validan cuenta/región, estado disponible, arquitectura x86_64 y etiqueta `Role`. El catálogo inicial debe usar los tamaños t3 admitidos por el módulo. P3 debe confirmar con P1/P4 los nombres y tamaños antes de integrar el PR.
- Integración actual: P3 ya está en `master`; `infra/packer/ami-ids.json` registra las cuatro AMIs 0.1.2, verificadas disponibles en la cuenta del equipo y `us-east-2`. El inventario de arranque usa únicamente `localhost` y la prueba del módulo con la plantilla integrada pasó. No usar AMIs 0.1.0; queda pendiente la prueba funcional conjunta con los IDs actuales.

## Puertos que deben conservarse

| Servicio | Puerto | Acceso previsto |
| --- | --- | --- |
| Frontend HTTP | 80 | Navegador |
| Backend | 5000 | Frontend/proxy y monitoreo según la ruta |
| PostgreSQL | 5432 | Backend del mismo tenant |
| node_exporter | 9100 | Servidor de monitoreo |
| process_exporter | 9256 | Servidor de monitoreo |
| OTel, métricas | 8889 | Servidor de monitoreo |
| Netdata | 19999 | Servidor de monitoreo |
| Prometheus | 9090 | Grafana y administración autorizada |
| Grafana | 3000 | Administración autorizada |

Health del backend actual: `/core/api/v1/health`. La ruta de métricas y su acceso los coordinan P4/P5. La base mantiene SSH/Grafana cerrados por defecto y el endpoint SSM de Parameter Store ya está creado. Los SG por tenant se crean al aplicar su módulo; falta la prueba funcional de un tenant. El PR #5 añade acceso S3 y canales/permisos del agente para respaldos vía Run Command en DB; aplicar esa ampliación y probarla con una AMI nueva sigue pendiente. Backend/BD continúan sin salida general a Internet.

Para la extensión de respaldos, P2/P4/P6 pasan `backup={schedule,retention_days}` y `base.backups_bucket`; vacío mantiene la función desactivada. La etiqueta DLM del volumen y del selector es `BackupPolicy=<project_name>:<schedule>-<retention_days>d`. No usar varias etiquetas de destino para simular un AND: DLM las combina con OR. Las AMIs 0.1.2 no contienen los scripts nuevos; P3 prevé la 0.2.0 y una prueba de restauración antes de activar esta función. El bucket de respaldos es distinto del bucket del tfstate.

Referencias: [S3 backend de Terraform](https://developer.hashicorp.com/terraform/language/backend/s3), [S3 backend de OpenTofu](https://opentofu.org/docs/language/settings/backends/s3/), [bloqueo S3 en OpenTofu 1.10](https://opentofu.org/docs/v1.10/intro/whats-new/).
