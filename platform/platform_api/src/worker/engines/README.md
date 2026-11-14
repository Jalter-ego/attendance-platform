# Conectar el adaptador de P2 al flujo create

P6 usa los adaptadores reales de P2 en `src/engines/adapter.js`. `createEngineAdapters(config)` los construye con la configuración compartida por API y worker. Terraform, OpenTofu y CloudFormation están conectados; Pulumi permanece deshabilitado. No se registra un simulador en producción.

## Contrato

- `preflight(context)`: comprueba fuentes y CLI antes de escribir secretos. No inicializa el backend ni habla con AWS.
- `apply(context)`: devuelve el resultado común `{status, outputs, tool_versions, resources, log_ref}`. El handler usa sus outputs/versiones directamente; `outputs(context)` y `versions(context)` sirven como alternativa para adaptadores que no los incluyan.
- `suspend`, `resume`, `destroy` y `preview`: conservan la interfaz de P2. La API valida estado/confirmación y el worker finaliza únicamente si todavía es dueño del trabajo.
- Outputs normalizados: `instance_ids`, `private_ips`, `urls.frontend` y opcional `db_volume_id`. No devolver el sobre `{value,type,sensitive}` de `terraform output -json`.

`context` contiene:

- `input`: configuración congelada del tenant, base, sizing/límites/respaldos del plan, AMIs, metadatos `image` y estado deseado `suspended`. Sin passwords ni JWT.
- `backend`: bucket, región, clave `tenants/<id>/<env>/terraform.tfstate`, cifrado y bloqueo para Terraform/OpenTofu. Para CloudFormation contiene `{type:"cloudformation", region, stack_name}` y no requiere un bucket de estado.
- `directory`: directorio estable por tenant/entorno/motor; no crear otro por cada reintento.
- `variableFile` (solo Terraform/OpenTofu): JSON preparado para Terraform, con la ruta absoluta de `cloud_init_template_path`.
- `backendFile` (solo Terraform/OpenTofu): configuración HCL de S3, sin credenciales. No se crean estos archivos para CloudFormation.
- `moduleDirectory`: fuentes de `infra/terraform/tenant` para Terraform/OpenTofu. Otros motores usan sus fuentes propias.
- `cloudInitTemplatePath`, `signal`, `report` y `execute(options)`.

Los adaptadores Terraform/OpenTofu usan directamente el mismo ejecutor común de procesos; CloudFormation usa el SDK de AWS con señal y plazo máximo. También está disponible `execute`, que reutiliza el ejecutor H4/H5, fija cwd y señal, transmite logs filtrados a `report`, usa workspace `default` y caché `.terraform` del tenant. También elimina flags heredados `TF_CLI_ARGS*`; los argumentos del adaptador son explícitos. `-json` se captura en privado y no se registra.

Para Terraform/OpenTofu el adaptador prepara las fuentes y lockfile en ese directorio, inicializa con `backendFile`, genera un plan nuevo usando `variableFile`, revisa su resultado y aplica el plan guardado. Mantener bloqueo y `-lock-timeout`; no pasar `-lock=false`, no usar `-force-copy` ni migrar el backend a otra clave para reintentar. Si copia `tests/`, recordar las opciones específicas de OpenTofu documentadas en `infra/terraform/README.md`.

El adaptador debe respetar `signal` y esperar los procesos. En un apply de Terraform/OpenTofu, la cancelación del usuario espera al final del paso; la pérdida del trabajo o apagado sí interrumpe el proceso. En CloudFormation, cancelar deja de seguir la operación remota, que puede continuar en AWS. Si un apply falla o se cancela, conservar estado y configuración; el siguiente intento reconcilia los recursos que alcanzaron a crearse. P6 no lanza otro apply automáticamente.

## Orden y persistencia

1. La API admite `{type:'create'}` solo a un administrador de plataforma. Sin adaptador responde `503 ENGINE_NOT_AVAILABLE`, sin cambiar el tenant ni escribir en AWS.
2. Dentro de una transacción bloquea la fila del tenant, exige estado `draft`/`failed` y rechaza otra operación activa. Congela configuración de base, plan, límites, AMIs y backend en `operations.params.deployment`.
3. También una nueva solicitud tras un fallo reutiliza el primer snapshot. Cambiar el catálogo, el plan o las variables locales no cambia silenciosamente un despliegue parcial. Modificar esa configuración requiere un flujo explícito posterior.
4. El worker ejecuta preflight → SSM → apply → outputs/versiones. Guarda un registro `deployments` en `provisioning` antes del health check.
5. En create y resume ejecuta el script de P4 `infra/health/tenant-health.sh` con la URL del frontend. No usa `--boot`: comprueba frontend/API/BD y guarda solo códigos, tiempos y resultado, sin body ni secretos.
6. Solo después de salud positiva y de confirmar que sigue siendo dueño de la operación, finaliza atómicamente operación, deployment y tenant como disponibles. Fallo/cancelación deja tenant/deployment en `failed` y conserva los recursos registrados.

CloudFormation conserva `stack_name`, `stack_id`, versión del SDK y hash de plantilla mediante una lista de campos permitidos. Se valida que el ARN corresponda a la región y al nombre congelado del tenant. Sus esperas y peticiones respetan `IAC_TIMEOUT_S` y la cancelación; completar requiere un evento raíz del token de la operación actual. Ver [la implementación de P2](../../../../../infra/cloudformation/README.md).

La salida pública se construye por lista de campos permitidos. El inventario guardado aquí contiene las tres EC2 y el EBS de datos si se informa; el backend del motor mantiene el inventario completo de SG/IAM y demás recursos. No copiar el JSON completo de estado, planes, outputs ni `resources` arbitrarios del adaptador a la base o a los logs.

## Configuración local

En `platform/platform_api/.env`, conservar la conexión actual a PostgreSQL y completar:

```dotenv
IAC_STATE_BUCKET=attendance-platform-tfstate-123456789012
AWS_PROFILE=attendance-terraform
```

`DEPLOYMENT_STATE_BUCKET` y los nombres de rutas anteriores de P6 se aceptan como aliases; si se configuran ambos nombres sus valores deben coincidir. Para Terraform/OpenTofu, reemplazar el bucket de ejemplo por el compartido que ya creó P1. CloudFormation no requiere esta variable: su estado es el stack administrado por AWS. No crear otro bucket por persona ni poner access keys en el repositorio. La base y el catálogo de AMIs se leen por defecto de `.local/base.outputs.json` e `infra/packer/ami-ids.json`; hay overrides en `.env.example`. Las rutas personalizadas deben ser accesibles desde el proceso que recibe la solicitud y desde el worker.

Antes de usar este código, desde `platform/platform_api`:

```bash
pnpm install
pnpm db:migrate
```

Se conservan `003_create_deployments.sql` y `003_engines.sql`, y se añade `004_unify_deployments.sql`. El migrador resuelve su columna coincidente tanto desde la 003 de P2 como la de P6, conservando checksums/datos. No modificar las migraciones ya aplicadas ni borrar tablas. Reiniciar API y worker. No hace falta ejecutar Terraform para instalar estos cambios de P6.

En la web: registrar institución → detalle → **Crear instalación en AWS** → progreso → accesos. Para motores todavía no conectados, el botón queda deshabilitado con un mensaje y el diagnóstico sigue funcionando. No se introdujo un despliegue simulado en el frontend.

## Verificación

```bash
pnpm test
TEST_DATABASE_URL=postgresql://attendance:attendance_local@127.0.0.1:5433/platform_test_create pnpm test:integration
```

La segunda orden requiere crear antes esa base **local y desechable**. La suite exige host localhost/127.0.0.1 y nombre `platform_test*`; elimina y reconstruye su esquema público. No carga `.env`. Prueba las cinco migraciones, ambos caminos de actualización, API/permisos, concurrencia, cancelación, salud fallida/inválida, reintentos congelados y pérdida de propiedad con PostgreSQL real. Incluye los adaptadores reales de P2 con un CLI ficticio o clientes CloudFormation/EC2 simulados y el ciclo create/suspend/resume/destroy. SSM/health se sustituyen por dobles de prueba; no valida un despliegue real en AWS.
