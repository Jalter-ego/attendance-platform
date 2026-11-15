# Plataforma de administración

El panel `platform_web/` usa React, TypeScript y Vite con el diseño verde del equipo. Incluye la portada, el asistente de P2 para crear instituciones, Respaldos de P3, Planes de P4 y las vistas operativas de P6. Consume la API Express de `platform_api/`. La API y el worker corren como procesos separados y comparten PostgreSQL.

**Crear tenant** puede registrar la institución como borrador o registrarla y encolar el aprovisionamiento en una sola transacción. El modo predeterminado `local` simula recursos, URLs, comprobaciones de salud y respaldos. El modo `integration` usa los motores Terraform, OpenTofu o CloudFormation y requiere una base separada y la configuración de infraestructura del equipo.

## Arrancar en local

Se requiere Node.js 22.13 o superior (recomendado 24), pnpm y PostgreSQL 16 o posterior. Todos los comandos parten de la raíz del repositorio, salvo donde se indica.

### 1. Base de datos nueva

Si ya tienes una base exclusiva para la plataforma, usa su conexión en el paso 2. No reutilices la base de Attendance ni las de los clientes.

Para levantar una local con Docker:

```bash
docker compose -f platform/compose.yaml up -d --wait
```

Se publica solo en `127.0.0.1:5433`. El archivo de ejemplo del backend ya coincide con esta configuración de desarrollo. Los datos quedan en un volumen local. `docker compose -f platform/compose.yaml stop` la detiene conservándolos; `down -v` los elimina.

### 2. Preparar el backend (una vez)

```bash
cd platform/platform_api
pnpm install --frozen-lockfile
cp .env.example .env
```

En PowerShell, el equivalente de la última línea es `Copy-Item .env.example .env`. Si ya tienes `.env`, conserva sus valores y revisa los ajustes siguientes.

Edita `.env`:

- `DATABASE_URL`: conexión de la base nueva de la plataforma.
- `DB_SSL=true` si la conexión lo requiere; se verifica el certificado por defecto.
- `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`: cuenta inicial de la plataforma, con contraseña de 12–128 caracteres. Cada instalación de Attendance gestiona sus propios usuarios.
- `CLIENT_ORIGIN`: `http://localhost:5173`, que será la dirección del frontend.
- `PLATFORM_DEPLOY_MODE=local`: simula el ciclo de vida sin conectarse a AWS.

Si usas un proyecto nuevo de **Supabase**, copia la URI de **Connect → Direct → Session pooler** (puerto 5432) y reemplaza la contraseña de la base, codificando los caracteres especiales de la URL. Configura también:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_FILE=certs/supabase-prod-ca-2021.crt
```

El certificado público del proveedor se incluye en `platform_api/certs/`; no es una clave privada. La ruta relativa parte de `platform/platform_api`. Deja fuera de `DATABASE_URL` los parámetros `sslmode`, `sslrootcert`, `sslcert` y `sslkey`, porque sobrescribirían la configuración SSL de `pg`. Para este proyecto utiliza PostgreSQL a través de Node y desactiva **Enable Data API** en el proyecto nuevo de Supabase; las migraciones no crean políticas RLS para los endpoints REST automáticos.

Comprueba primero la conexión, sin crear tablas:

```bash
pnpm db:check
```

Los errores de certificado, autenticación, DNS y tablas ausentes ahora se distinguen sin mostrar credenciales. Un error `SELF_SIGNED_CERT_IN_CHAIN` indica que falta configurar la CA; `28P01` indica credenciales rechazadas; `42P01` indica que aún faltan migraciones. Referencias: [SSL de Supabase](https://supabase.com/docs/guides/platform/ssl-enforcement), [SSL de pg](https://node-postgres.com/features/ssl).

Después, desde esa misma carpeta:

```bash
pnpm db:migrate
pnpm admin:create
pnpm dev
```

La API escucha en `http://127.0.0.1:5001/api/v1`. Las migraciones se pueden repetir; no se vuelven a aplicar. Para cambios posteriores crea otra migración, sin modificar una ya aplicada. El administrador inicial tampoco se duplica ni cambia de contraseña al repetir el comando.

### 3. Worker (otra terminal)

Desde la raíz:

```bash
cd platform/platform_api
pnpm worker:dev
```

Sin este proceso los trabajos permanecen **en cola**. No se pierden al reiniciar la API porque están en PostgreSQL. Una operación cuyo worker deja de responder se marca fallida tras el tiempo de `WORKER_STALE_MS`; requiere reintento explícito.

### 4. Panel web

Desde la raíz:

```bash
cd platform/platform_web
pnpm install --frozen-lockfile
pnpm dev
```

Abre [localhost:5173](http://localhost:5173) e ingresa con la cuenta inicial. Vite reenvía `/api/v1` a `http://127.0.0.1:5001` por defecto. Para cambiar ese destino, configura `PLATFORM_API_TARGET` en el `.env` de `platform_web/`. La sesión dura ocho horas por defecto y se invalida al cerrar sesión.

Para servir el panel en el mismo puerto de la API, ejecuta `pnpm build` en `platform_web/`. En el `.env` de `platform_api/`, establece `PLATFORM_WEB_DIST=../platform_web/dist` y fija `CLIENT_ORIGIN` a la dirección que abrirás en el navegador. Reinicia la API con `pnpm start`. El worker se inicia en otra terminal con `pnpm worker`.

Sigue el [manual de la demo local](README.local.md) para probar el asistente, los accesos y el ciclo de vida.

## Organización para el equipo

```text
platform_api/
  migrations/                 Tablas y catálogo inicial
  scripts/                    Migraciones y administrador inicial
  src/modules/auth/          Sesiones y permisos
  src/modules/tenants/       Registro, filtros y detalle
  src/modules/plans/         Catálogo versionado
  src/modules/audit/         Auditoría de operaciones y cambios
  src/modules/operations/    Cola, consultas y eventos
  src/modules/deployments/   Configuración congelada y resultados del despliegue
  src/worker/                Proceso que reclama y ejecuta trabajos
  src/db/                    Conexiones y transacciones
  src/lib/                   Errores, contraseñas y redacción de logs
platform_web/src/
  features/auth/             Contexto, hooks, servicios y login
  features/landing/          Portada pública y referencia local de la app
  features/backups/          Historial, respaldo y restauración
  features/plans/            Catálogo de planes
  features/tenants/          Listado, registro y detalle
  features/operations/       Progreso, eventos, auditoría y alertas
  components/                Layout y componentes compartidos
  hooks/                     Consulta/refresco de datos
  lib/                       Cliente HTTP
```

- **P1/P2/P6:** el ciclo completo del worker usa Terraform/OpenTofu. El [adaptador y la plantilla de CloudFormation de P2](../infra/cloudformation/README.md) y el [programa Pulumi](../infra/pulumi/README.md) se usan para crear tres EC2, suspender, reanudar y eliminar con vista previa. Actualización y cambio de plan no están habilitados para CloudFormation/Pulumi. El modo local simula todos los motores.
- **P3/P4/P5:** los respaldos reales usan el script de P3; el worker usa los scripts de actualización y salud de P4. Alertas y resultados de seguridad se reciben mediante el token opcional de servicio.

Las contraseñas se guardan con scrypt. En sesiones solo se conserva el hash del token. El rol `tenant_admin` limita la lectura a su institución. El administrador de plataforma gestiona esas cuentas, edita el catálogo y consulta la auditoría. El historial combina el estado de los trabajos con registros de cambios de acceso, catálogo, registro de instituciones y solicitudes de cancelación.

## Contrato de API inicial

Prefijo: `/api/v1`. Los cuerpos son JSON y la autenticación usa la cookie HttpOnly `platform_session`. Para otro cliente HTTP, conservar la cookie entre solicitudes. Las solicitudes desde el navegador deben provenir de `CLIENT_ORIGIN`.

| Método y ruta | Función | Acceso |
| --- | --- | --- |
| `GET /health` | Conectividad de API/PostgreSQL | Público |
| `POST /auth/login` | Crea sesión con `{email,password}` | Público, con límite de intentos |
| `GET /auth/me` | Usuario actual y modo de despliegue | Sesión |
| `POST /auth/logout` | Invalida sesión | Sesión |
| `GET /plans` | Catálogo de planes | Sesión |
| `POST /plans` | Crear un plan con `{code,name,description,sizing,limits,backup}` | Administrador de plataforma |
| `GET/PUT/DELETE /plans/:code` | Consultar, editar con la versión vigente o eliminar un plan sin historial de uso | Administrador de plataforma |
| `GET /engines` | Modo de despliegue y motores disponibles para el asistente de P2 | Sesión |
| `GET /tenants` | `q`, `status`, `env`, `plan`, `limit`, `offset` | Sesión, filtrado por permisos |
| `POST /tenants` | Registrar institución, sin desplegar | Administrador de plataforma |
| `POST /tenants/provision` | Registrar y encolar creación atómicamente; acepta `simulate_failure` en local | Administrador de plataforma |
| `GET /tenants/:id` | Datos, últimas 20 operaciones, 10 despliegues y disponibilidad de creación | Sesión, filtrado por permisos |
| `GET /tenants/:id/backups` | Respaldos simulados en local, dumps S3 y snapshots EBS en integración | Sesión, filtrado por permisos |
| `GET/POST /tenants/:id/admins` | Listar o crear un administrador con `{name,email,password}` | Administrador de plataforma |
| `PATCH /tenants/:id/admins/:adminId` | Cambiar contraseña o estado con `{password?,active?}` | Administrador de plataforma |
| `POST /tenants/:id/operations` | Encolar diagnóstico, creación, suspensión, reanudación, actualización, cambio de plan, respaldo, restauración, vista previa o eliminación | Administrador de plataforma |
| `GET /operations/:id` | Estado, etapa y porcentaje | Sesión, filtrado por permisos |
| `GET /operations/:id/logs?after=0` | Eventos por cursor | Sesión, filtrado por permisos |
| `POST /operations/:id/cancel` | Cancelar trabajo en cola/en curso | Administrador de plataforma |
| `POST /operations/:id/retry` | Nuevo trabajo vinculado al fallido/cancelado | Administrador de plataforma |
| `GET /audit` | Historial con filtros `q`, `env`, `status`, `limit` y `offset` | Administrador de plataforma |
| `GET /alerts` y `GET /tenants/:id/security` | Alertas y escaneos de seguridad | Sesión, filtrado por permisos |
| `POST /alerts/webhook` y `POST /tenants/:id/security` | Recepción de alertas y escaneos | Token de servicio |

Las rutas usan el **`id` UUID** de la base de la plataforma. `tenant_id`, por ejemplo `san-marcos`, es el identificador estable que se pasa a IaC; la pareja `(tenant_id, env)` es única. No intercambiar ambos identificadores.

Cada tenant conserva en `plan_snapshot` la versión de sus tamaños, límites y política de respaldo. Editar el catálogo crea otra revisión. Para aplicarla a un tenant existente, revisa y confirma un cambio de plan. La migración `006_unify_plan_snapshots.sql` conserva los valores que se habían fijado en instalaciones anteriores de P6.

Entrada de registro:

```json
{
  "tenant_id": "san-marcos",
  "name": "Instituto San Marcos",
  "contact_email": "admin@example.com",
  "env": "test",
  "plan": "basic",
  "engine": "terraform",
  "timezone": "America/La_Paz"
}
```

Los errores tienen `{ "error": { "code": "...", "message": "..." } }`; la validación puede añadir `fields`. Una segunda operación activa devuelve `409 TENANT_BUSY`. Los logs devuelven `{items,next_cursor,has_more}`; usar el cursor siguiente para evitar duplicados. El frontend consulta el progreso mediante polling. Para `plan-change` y `delete`, encola antes `preview-plan` (con `plan`) o `preview-delete`, muestra el resultado y envía el ID de la vista previa como `preview_id`; `delete` también exige `confirm:true`.

La cola reclama trabajos con transacciones y `FOR UPDATE SKIP LOCKED`. Un índice único impide más de un trabajo activo por tenant. El heartbeat identifica al worker dueño y consulta la cancelación aunque no haya logs. El reintento de creación vuelve a planificar con la misma clave de estado; un plan destructivo que cambió requiere otra vista previa.

Las rutas de ciclo de vida también se pueden usar como `POST /tenants/:id/{suspend,resume,upgrade,backup,restore,retry}`, `POST /tenants/:id/plan-change/preview` y `/plan-change`. Para eliminar, `POST /tenants/:id/delete-preview` encola el cálculo, `GET /tenants/:id/delete-preview` devuelve la última vista previa vigente del operador y `DELETE /tenants/:id` confirma con `{preview_id,confirm:true}`. El reintento por tenant recibe `{operation_id}`. Las rutas usan la misma cola del panel.

## Respaldos (P3)

En **Respaldos**, selecciona una institución para consultar sus copias, respaldar o restaurar. La restauración pide escribir el `tenant_id`. Ambas acciones usan la cola de operaciones y su bloqueo por tenant, eventos, cancelación y reintento. En modo integración, el worker ejecuta `infra/backups/tenant-backup.sh` con las credenciales de AWS del proceso y guarda el resultado en `operations.result`. El listado `GET /tenants/:id/backups` llama al mismo script con `list`.

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `BACKUP_BASH` | `bash`; en Windows `C:\Program Files\Git\bin\bash.exe` | Bash que ejecuta el script. En Windows usar Git Bash, no el de WSL (no ve las credenciales de AWS de Windows) |
| `BACKUP_SCRIPT` | `infra/backups/tenant-backup.sh` del repositorio | Ruta del script |
| `BACKUP_TIMEOUT_S` | `900` | Tiempo máximo del comando en la VM db |

En modo `integration`, requiere AWS CLI v2, la VM db del tenant encendida y AMIs ≥ 0.2.1. El proceso hijo no recibe `DATABASE_URL` ni los secretos de la plataforma. Cancelar corta el script local; un comando que ya llegó a la VM db puede terminar allí. En modo `local` se usa el catálogo simulado de respaldos. Pruebas sin AWS: `pnpm test:backups`.

## Activación con AWS

Configura una base separada con `PLATFORM_DEPLOY_MODE=integration`. El worker integrado usa las salidas `terraform output -json integration` y el bucket de estado configurados en `IAC_BASE_OUTPUTS` e `IAC_STATE_BUCKET`. `PLATFORM_BASE_OUTPUT_FILE` y `PLATFORM_STATE_BUCKET` permiten sobrescribirlos. Usa un `PLATFORM_WORK_ROOT` persistente para conservar el contexto de cada tenant. Configura el perfil del equipo, `TERRAFORM_BIN` o `TOFU_BIN` y Bash. Para actualizar la aplicación, la versión solicitada debe estar publicada según el [contrato de P4](../docs/contrato-actualizacion.md).

El primer aprovisionamiento real guarda la configuración de red, estado y AMIs junto con la operación. El worker registra los recursos antes de comprobar su salud. Los reintentos recuperan la configuración del intento anterior. CloudFormation conserva su estado en el stack. Usa `pnpm db:migrate` al actualizar una instalación y reinicia la API y el worker. El migrador conserva los checksums de las migraciones publicadas.

La integración de P6 se verifica en local con dobles de los comandos. Queda por comprobar el despliegue en una cuenta de AWS, incluidos el arranque, el reintento y la conservación de datos durante el ciclo de vida.

## Verificación

```bash
cd platform/platform_api
pnpm test
```

La suite comprueba el ejecutor de procesos, filtrado de secretos, respaldos de P3, cancelación/propiedad del worker, preparación de SSM y las invocaciones del adaptador. Usa procesos ficticios y dobles de la base y de SSM. Ver [el contrato del ejecutor y las pruebas](platform_api/src/worker/README.md).

Para comprobar SQL, sesiones, permisos y el ciclo simulado con PostgreSQL real, inicia la API y el worker en modo local con una base dedicada y ejecuta `pnpm test:e2e:local`. La prueba crea y elimina un tenant de prueba. Usa `LOCAL_E2E_URL` si el servidor no está en el puerto 4100.

La suite `pnpm test:integration` verifica la ruta de creación de PR #26 con PostgreSQL real y dobles de Terraform, CloudFormation, SSM y salud. Define `TEST_DATABASE_URL` para una base local desechable cuyo nombre comience por `platform_test`. La suite reconstruye el esquema público de esa base.

Desde `platform/platform_web/`:

```bash
pnpm lint
pnpm build
```

Referencias: [Express](https://expressjs.com/en/guide/writing-middleware/), [transacciones de node-postgres](https://node-postgres.com/features/transactions), [colas con SKIP LOCKED](https://www.postgresql.org/docs/16/sql-select.html).
