# Instalación por tenant con Pulumi — P2, D3

`tenant/` es un programa Pulumi en **JavaScript** (el mismo lenguaje del backend) que crea el **mismo stack** que [`infra/terraform/tenant`](../terraform/tenant/README.md) y [`infra/cloudformation/tenant.yaml`](../cloudformation/README.md). Lo usan los tenants registrados con `engine=pulumi`, y la plataforma lo ejecuta con el adaptador `platform/platform_api/src/engines/pulumi.js`.

| Archivo | Contenido |
| --- | --- |
| `tenant/tenant.js` | Recursos, validaciones de entrada y precondiciones de red (equivalentes a `variables.tf` y `locals.tf`). |
| `tenant/cloud-init.js` | User data equivalente a `infra/cloud-init/user-data.yaml.tftpl`: Pulumi no interpreta plantillas HCL. |
| `tenant/index.js` | Lee la entrada del tenant desde la configuración del stack (`attendance-tenant:input`) y exporta los outputs. |
| `tenant/test/` | Pruebas con los mocks de Pulumi: construyen el grafo de recursos sin AWS. |

## Qué crea (un stack por tenant y entorno)

Stack: `organization/attendance-tenant/<tenant_id>-<env>`, por ejemplo `organization/attendance-tenant/san-marcos-test`.

| Recurso | Detalle |
| --- | --- |
| 3 EC2 | Frontend (subred pública con IP pública), backend y base de datos (subred privada), desde las AMIs de Packer. IMDSv2 obligatorio, disco raíz gp3 cifrado de 12 GiB y `userDataReplaceOnChange`. |
| EBS de datos | gp3 cifrado del tamaño del plan, adjuntado en `/dev/sdf`, con la etiqueta `BackupPolicy` de DLM si hay bucket de respaldos. Lleva **`protect: true`**: un `pulumi up` no puede eliminarlo ni reemplazarlo. |
| 3 grupos de seguridad y 19 reglas | Las mismas que `security.tf`: HTTP 80 al frontend, API 5000 solo desde el frontend y el monitoreo, PostgreSQL 5432 solo desde el backend, exporters solo desde el SG de monitoreo. |
| IAM | Un rol y un perfil por servidor, con los mismos nombres que Terraform. Backend y db leen solo `/tenants/<id>/<env>/*` en SSM; el frontend no lee secretos. Con bucket de respaldos se agregan el agente SSM, `releases/` y `db/`. |
| Estado de las EC2 | `aws.ec2transitgateway.InstanceState` (el `aws_ec2_instance_state` de Terraform) con `running` o `stopped`. |

El proveedor aplica las etiquetas `Project`, `Tenant`, `Env`, `Plan` y `ManagedBy=pulumi` a todos los recursos. Cada recurso lleva además `Role`. El programa también comprueba, igual que las precondiciones de Terraform:

- que las subredes y el SG de monitoreo pertenecen a la VPC compartida;
- que la base de datos está en la misma AZ que su disco;
- que el endpoint SSM está disponible y tiene DNS privado;
- que cada AMI es propia, x86_64 y tiene la etiqueta `Role` correcta.

## Cómo lo ejecuta la plataforma

Directorio de ejecución por tenant: `.local/runs/<tenant>/<env>/pulumi/`, con un `Pulumi.yaml` generado (`main` apunta a `infra/pulumi/tenant`) y el `Pulumi.<stack>.yaml` del stack. El repositorio no recibe archivos de ningún tenant.

| Operación | Qué hace el adaptador |
| --- | --- |
| `create` | `stack select --create`, `config set` (la entrada llega **por stdin**, no en los argumentos), `preview --json`. Si el preview eliminaría o reemplazaría el disco de datos, se detiene; si no hay cambios, no ejecuta `up`. Después `up --skip-preview` y `stack output --json`. |
| `suspend` / `resume` | **Declarativo**: el mismo `up` con `suspended=true/false` cambia los `InstanceState` y vuelve a leer la IP pública del frontend. No hace falta llamar a la API de EC2 aparte, como en CloudFormation (D5). |
| vista previa de eliminación | `stack export` (capturado en privado) lista los recursos y calcula una huella SHA-256. |
| `delete` | Rechaza la operación si la huella no coincide con la vista previa confirmada. Después `state unprotect --all` (solo aquí se libera el disco) y `destroy`. |

Cancelar desde la plataforma espera a que termine el `up` o el `destroy` en curso, para no dejar el estado a medias. Perder la operación o apagar el worker sí lo detiene, con 60 s de gracia. Los errores se traducen a mensajes comprensibles: bloqueo del stack, frase de cifrado, credenciales, cuota de vCPU, AMIs y disco protegido.

## Estado y su protección (A6)

- **Dónde:** backend DIY de Pulumi en el bucket de estado de P1, `s3://<IAC_STATE_BUCKET>/pulumi/`, separado de las claves `tenants/` de Terraform. El bucket ya tiene versionado, cifrado SSE, bloqueo de acceso público y una política que exige TLS. Con `PULUMI_BACKEND_URL` se puede usar otro backend (por ejemplo `file://` para pruebas locales).
- **Aislamiento:** un stack por tenant y entorno. Cada `up`, `destroy` o `unprotect` toma el **bloqueo del stack** en el backend. Además, la cola de la plataforma no permite dos operaciones del mismo tenant.
- **Cifrado de secretos del stack:** `PULUMI_SECRETS_PROVIDER` (por defecto `passphrase`, con `PULUMI_CONFIG_PASSPHRASE` en el `.env` del worker; para producción se recomienda `awskms://alias/<clave>?region=...`). La configuración del tenant no contiene secretos: las contraseñas viven en SSM (`/tenants/<id>/<env>/`) y nunca pasan por Pulumi. La frase se pasa solo por variable de entorno y se redacta en los logs.
- **Protección de datos:** `protect: true` en el EBS de PostgreSQL, el bloqueo previo del adaptador y la confirmación por huella antes de eliminar.

## Permisos del worker

Los mismos que el módulo Terraform: EC2 (instancias, volúmenes, SG y sus reglas, `Describe*`, `StopInstances` y `StartInstances`), IAM (roles, políticas en línea, perfiles e `iam:PassRole`), `sts:GetCallerIdentity`, más lectura y escritura en `s3://<bucket>/pulumi/*`. Con KMS se suman `kms:Encrypt` y `kms:Decrypt` sobre la clave del proveedor de secretos.

## Instalar y probar

```bash
pnpm --dir infra/pulumi/tenant install        # @pulumi/pulumi y @pulumi/aws (fijados)
pnpm --dir infra/pulumi/tenant test           # 7 pruebas con mocks de Pulumi, sin AWS
cd platform/platform_api && pnpm test:pulumi  # 11 pruebas del adaptador con un CLI simulado
```

La primera ejecución real descarga el plugin del proveedor AWS de Pulumi, que ocupa unos cientos de MB.

Uso manual opcional, sin la plataforma. Requiere los outputs de la base y que los secretos de SSM ya existan:

```bash
cd infra/pulumi/tenant
export PULUMI_CONFIG_PASSPHRASE=...           # o --secrets-provider awskms://...
pulumi login s3://<IAC_STATE_BUCKET>/pulumi?region=us-east-2
pulumi stack init organization/attendance-tenant/prueba-test
pulumi config set attendance-tenant:input "$(cat entrada-del-tenant.json)"
pulumi preview
```

Elimina los recursos al terminar las pruebas: `pulumi state unprotect --all --yes && pulumi destroy`. Esto también borra el disco de datos.
