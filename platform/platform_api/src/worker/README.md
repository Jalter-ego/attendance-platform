# Ejecución del worker — P6, H4/H5 y SSM

`services/command-runner.js` es el ejecutor común para los adaptadores de P2 y los respaldos de P3. No publica una ruta HTTP para ejecutar comandos. El adaptador elige el ejecutable, los argumentos y el directorio del tenant; el navegador solo solicita operaciones permitidas por la API.

## Comandos con progreso

Ejemplo dentro de un handler del worker, con rutas preparadas por el adaptador:

```js
import { runCommand } from './services/command-runner.js';

const result = await runCommand({
  command: 'terraform',
  args: [
    'plan', '-input=false', '-no-color', '-lock-timeout=5m',
    `-var-file=${varFile}`, `-out=${planFile}`, '-detailed-exitcode',
  ],
  cwd: deploymentDirectory,
  signal,
  timeoutMs: 15 * 60 * 1000,
  killGraceMs: 10000,
  acceptedExitCodes: [0, 2],
  onLine: (line, stream) => report(line, {
    level: stream === 'stderr' ? 'warning' : 'info',
  }),
});
```

Cada argumento se pasa por separado con `shell:false`; no construir una cadena de shell ni aceptar un ejecutable/ruta/argumentos arbitrarios del cliente HTTP. Los directorios y planes son propios del tenant/entorno. `signal` y `report` son los del handler; no ocultar sus errores ni ejecutar el proceso sin esperarlo.

`onLine` recibe líneas UTF-8 completas y filtradas; sus callbacks se serializan. La API existente las entrega por cursor y el frontend las consulta mientras sigue el proceso. No se agregó SSE: el polling existente sigue mostrando el progreso. El worker comprueba también `cancel_requested` en el heartbeat, cada cinco segundos, aunque no haya salida.

En Linux/macOS, cancelar envía SIGTERM al grupo de procesos y luego SIGKILL tras el período de gracia; en Windows se usa `taskkill /T /F`. Espera además el cierre de las tuberías. Linux está probado; Windows queda pendiente de verificar por el equipo. Los adaptadores de P2 difieren la cancelación solicitada por el usuario durante apply hasta terminar ese paso; la pérdida de propiedad/apagado sí termina el proceso, con 60 s de gracia. Detener el proceso local no revierte lo ya creado en AWS ni cancela necesariamente una operación remota de SSM/CloudFormation. Tras una interrupción, revisar el estado y generar otro plan con el mismo backend. No borrar locks de operaciones activas ni crear otro estado para reintentar.

## Salida y secretos

- Por defecto: 15 minutos de ejecución, 5 segundos de gracia, 8 MiB de salida total y 64 KiB por línea. Se puede ajustar por llamada. Superar los límites detiene el proceso y produce un error legible; un callback de logs bloqueado tampoco impide el timeout o la cancelación.
- Los errores de inicio, ejecutable ausente, salida inválida, tiempo máximo y cancelación tienen `code`; no incluyen los argumentos, rutas o mensajes nativos del sistema. Los errores de `report` se propagan para que el worker respete la cancelación o la pérdida de propiedad del trabajo.
- Los procesos heredan las credenciales AWS del operador. Se excluyen `DATABASE_URL`, `DB_*`, `PGPASSWORD`, `BOOTSTRAP_ADMIN_*`, `JWT_*`, `SESSION_*`, `NODE_OPTIONS` y `TF_LOG*`.
- Se filtran secretos conocidos del entorno, los adicionales pasados en `secrets`, contraseñas con espacios, Bearer/JWT, claves AWS, conexiones PostgreSQL y bloques de claves privadas. No pasar secretos por argumentos; para datos privados se admite `input` por stdin, sin registrarlo. Pasar los valores que puedan aparecer impresos en `secrets`.
- `captureStdout:true` devuelve `{exitCode, stdout}`. **Ese stdout es privado y puede contener secretos.** Usarlo solo para parsear y validar una salida de máquina; guardar únicamente campos permitidos, nunca el texto completo en logs ni en `operations.result`.
- Para `terraform show -json` y equivalentes usar `captureStdout:true, logStdout:false`. Cualquier comando con el argumento `-json` ya suprime stdout en los logs, porque un secreto puede aparecer bajo un nombre genérico como `value`. El resumen público lo prepara `infra/terraform/plan_preview.py`.
- El filtrado no convierte cualquier documento en publicable: el adaptador debe elegir qué campos de outputs/JSON guarda. No imprimir planes completos, variables o valores recuperados de SSM.

Los respaldos conservan el contrato `runBackupScript` de P3, sus etapas y su JSON final, usando este ejecutor. Su cancelación detiene el script local; un Run Command que ya llegó a EC2 puede continuar allí.

## Preparar secretos antes de crear infraestructura

```js
import { ensureTenantSecrets } from './services/tenant-secrets.js';

const prepared = await ensureTenantSecrets(tenant, {
  signal,
  projectName: base.project_name,
});
await report('Secretos de la institución preparados.', {
  stage: 'Preparando instalación', progress: 15,
});
// Después: adaptador de P2 con nombres/prefijo; nunca con valores de secretos.
```

Recibe `tenant_id`, `env` y `region` del registro validado. Usa el SDK oficial de SSM, con las credenciales/perfil AWS del worker, y un plazo total de 60 segundos. El administrador de la plataforma y el administrador del producto siguen siendo cuentas diferentes.

Crea estos `SecureString` bajo `/tenants/<tenant_id>/<env>/`:

| Nombre | Uso |
| --- | --- |
| `db_password` | PostgreSQL y conexión del backend |
| `jwt_secret` | Firma de tokens de Attendance |
| `admin_password` | Administrador inicial del producto |

Genera 32 bytes aleatorios por secreto, representados como 64 caracteres hexadecimales, compatibles con el arranque de P3/P4. Usa `Tier=Standard`, `alias/aws/ssm`, etiquetas Project/Tenant/Env y `Overwrite=false`. Solo consulta metadatos: no recupera valores existentes. Devuelve `{ssm_prefix, created, reused}` con nombres, sin contraseñas.

Si ya existe un `SecureString`, lo conserva. Si existe un `String`/`StringList`, se detiene para revisión. Si hay una carrera de creación, comprueba el parámetro existente y lo reutiliza. Un fallo parcial conserva lo creado para que otro intento complete los pendientes; no borra ni rota credenciales automáticamente.

Permisos del operador/worker: `ssm:DescribeParameters` para metadatos, `ssm:PutParameter` y `ssm:AddTagsToResource` sobre su prefijo. Las EC2 mantienen sus permisos de lectura ya definidos por Terraform. El servicio no crea usuarios IAM ni modifica esas políticas.

El handler `create` ya llama a este servicio antes del primer apply. Los adaptadores de Terraform/OpenTofu de P2 están conectados: [contrato de integración](engines/README.md). Sin adaptador para el motor elegido, la API rechaza create antes de encolar o escribir secretos; registrar una institución y ejecutar el diagnóstico siguen sin escribir en SSM ni crear EC2.

## Pruebas locales

```bash
cd platform/platform_api
pnpm install
pnpm test
```

Las pruebas de `pnpm test` usan procesos ficticios, una conexión simulada para el worker y un cliente SSM simulado. No cargan `.env`, no consultan AWS ni modifican PostgreSQL. `pnpm test:runner` limita la ejecución a procesos y filtrado; `pnpm test:backups` conserva las pruebas de P3.

El migrador conserva los checksums de las versiones publicadas y reconcilia sus cambios de despliegues y operaciones. La suite `pnpm test:integration` usa PostgreSQL local desechable y AWS simulado. `pnpm test:e2e:local` prueba la API y el worker en modo local.

Referencias: [procesos y grupos de Node.js](https://nodejs.org/api/child_process.html#optionsdetached), [credenciales del SDK de AWS](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html), [PutParameter](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_PutParameter.html), [DescribeParameters](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_DescribeParameters.html).
