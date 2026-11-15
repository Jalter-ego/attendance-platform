# Pulumi: tenants reales desde el worker local

`tenant/` es un programa Node.js de Pulumi AWS Classic. Crea exactamente tres EC2
(`frontend`, `backend`, `db`) en la base compartida, tres SG, perfiles/roles IAM,
un volumen EBS gp3 cifrado independiente para PostgreSQL, su attachment y tres
recursos `InstanceState`. No crea otra VPC, NAT ni bucket. Requiere las AMIs de
Packer con `attendance-boot` y la base exportada de P1.

## Configuración

```dotenv
PULUMI_BIN=pulumi
IAC_PULUMI_DIR=/ruta/attendance-platform/infra/pulumi/tenant
IAC_STATE_BUCKET=attendance-state-<cuenta>
PULUMI_BACKEND_URL=s3://attendance-state-<cuenta>/pulumi
PULUMI_CONFIG_PASSPHRASE=<valor-local-aleatorio-y-persistente>
AWS_PROFILE=default
```

`IAC_PULUMI_DIR` es opcional; se resuelve desde el módulo del adaptador. El backend
por defecto es `s3://<IAC_STATE_BUCKET>/pulumi`. El bucket debe existir previamente;
Pulumi administra checkpoints, historial y bloqueos allí. El perfil del operador
debe poder leer/escribir ese prefijo y administrar los recursos del tenant.
No se guarda el perfil ni ninguna clave AWS en el programa o sus entradas.

La passphrase se obtiene únicamente del entorno/configuración local del worker;
no se incluye en argumentos, archivos de entrada ni checkpoints. Conservarla entre
reinicios. No es la contraseña PostgreSQL. Es posible usar `file:///ruta/estado`
como backend de pruebas. La passphrase es obligatoria también allí.

El worker copia `Pulumi.yaml`, `index.js`, `package.json` y `package-lock.json` a
su directorio privado por tenant. Instala exactamente el lock con `npm ci
--ignore-scripts` cuando cambia su hash. El CLI instala el plugin AWS que el
programa requiere. Node.js debe incluir npm; `NPM_CLI_JS` permite indicar otra
ruta absoluta al script `npm-cli.js` en instalaciones no estándar.

## Identidad y contrato de integración

Stack: `<base.project_name>-<tenant_id>-<env>`. El backend fijado en el snapshot es:

```json
{"type":"pulumi","region":"us-east-2","bucket":"attendance-state-123","url":"s3://attendance-state-123/pulumi","stack_name":"attendance-demo-test"}
```

El adaptador exporta `createPulumiAdapter(config)` en
`platform/platform_api/src/engines/pulumi.js`. Implementa `preflight`, `versions`,
`preview`, `apply`, `outputs`, `suspend`, `resume`, `destroy` con el contrato común
`EngineResult`. Los outputs permitidos son `urls`, `instance_ids`, `private_ips`,
`db_volume_id`, `ssm_prefix`, `suspended` y `stack_name`.

`runPulumiLifecycle` en `worker/services/pulumi-lifecycle.js` integra create,
suspend, resume, preview-delete y delete. Devuelve `{tenantStatus,deployment,result}`.
Fija la entrada original en disco y conserva AMIs, plan, red y backend en reintentos
y cambios de energía. Cambios de plan y upgrades se rechazan hasta integrar un
flujo que actualice también los límites de la aplicación.

La vista previa de eliminación devuelve `stack_name`, `fingerprint`, `lines`,
`totals` y `data_volumes_deleted`; el resultado presentado al usuario lleva
`changes`, `downtime`, `stack_name` y `fingerprint`. `destroy(ctx,{expectedPreview})`
exige que el hash SHA256 del checkpoint y el backend sigan coincidiendo.

## Protección de datos y cancelación

Los secretos de aplicación viven en SSM y los lee `attendance-boot` en EC2.
Pulumi recibe el prefijo, nunca los valores. El frontend no puede leer parámetros;
backend y DB tienen permisos solamente sobre su tenant/entorno. Las descargas de
releases y dumps S3 también se restringen por prefijo. No se usa
`AmazonSSMManagedInstanceCore`, que permitiría leer parámetros ajenos.

Preview utiliza JSON privado y `--save-plan`; `up` consume exactamente ese archivo
con `--plan`. Toda eliminación/reemplazo de un volumen EBS bloquea apply, suspend
y resume. Solo destroy con vista previa vigente puede eliminar el disco.
El plan temporal se elimina incluso al fallar. Los inputs no incluyen contraseñas.
Los stdout de preview, export y output se capturan sin registrarlos y los outputs
retornados usan una lista permitida. Los comandos mutadores suprimen outputs;
el ejecutor compartido redacta los logs.

Una cancelación de usuario espera el final de `up`/`destroy` y después marca la
operación cancelada; una pérdida de lease, apagado del worker o timeout sí termina
el proceso. Nunca se ejecuta `pulumi cancel` ni se elimina un bloqueo ajeno
automáticamente. Tras una terminación forzada se debe revisar el stack antes de
reintentar; conservar los checkpoints y bloqueos del backend.

Suspender cambia `InstanceState` a `stopped`: no elimina EC2 ni EBS. Reanudar cambia
a `running`. La IP pública se consulta después de completar el cambio de energía.
IMDSv2 es obligatorio, los root disks están cifrados y no existe SSH entrante.
Las únicas entradas públicas son HTTP/80 del frontend. El servicio base debe
proporcionar la salida y los endpoints necesarios para SSM/S3.

## Validación local sin AWS

Desde `platform/platform_api`:

```sh
node --test tests/pulumi.test.js
```

Las pruebas utilizan un doble del ejecutor y verifican orden preview/up, uso del
plan revisado, aislamiento, JSON privado, protección del disco, fingerprint de
eliminación, suspensión, cancelación y contrato del ciclo de vida. No crean AWS.

Desde `infra/pulumi/tenant`, después de `npm ci --ignore-scripts`, `npm test`
ejecuta además el programa con mocks del SDK real y una prueba del CLI instalado
con backend local y un solo ComponentResource. Esta última se omite si Pulumi no
está instalado. No invoca proveedores AWS ni requiere credenciales.

Referencias oficiales consultadas:

- [Pulumi preview y planes guardados](https://www.pulumi.com/docs/iac/cli/commands/pulumi_preview/)
- [Pulumi up](https://www.pulumi.com/docs/iac/cli/commands/pulumi_up/)
- [Pulumi destroy](https://www.pulumi.com/docs/iac/cli/commands/pulumi_destroy/)
- [Selección y creación de stacks](https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_select/)
- [AWS EC2 Instance](https://www.pulumi.com/registry/packages/aws/api-docs/ec2/instance/)
