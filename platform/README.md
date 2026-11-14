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
  src/engines/               EngineAdapter, Terraform/OpenTofu y CloudFormation (P2)
  src/modules/provisioning/  Operaciones create/suspend/resume/destroy del worker (P2)
  src/modules/plans/         Catálogo de planes: CRUD, validación y versiones (P4)
  src/db/                    Conexiones y transacciones
  src/lib/                   Errores, contraseñas y redacción de logs
platform_web/src/
  features/auth/             Contexto, hooks, servicios y login
  features/landing/          Portada pública y referencia local de la app
  features/backups/          Historial, respaldo y restauración
  features/plans/            Catálogo de planes
  features/tenants/          Listado, registro y detalle
  features/operations/       Progreso, eventos y acciones
  features/plans/            Pantalla Planes y editor de planes (P4)
  features/operations/       Progreso, eventos, auditoría y alertas
  components/                Layout y componentes compartidos
  hooks/                     Consulta/refresco de datos
  lib/                       Cliente HTTP
```

- **P2:** adaptadores Terraform/OpenTofu conectados al worker (operaciones `create`, `suspend`, `resume`, `destroy`; ver [Motores IaC](#motores-iac-p2)). Wizard **Crear tenant** de 3 pasos en `/tenants/new`. CloudFormation conectado ([plantilla](../infra/cloudformation/README.md)). Pendiente: Pulumi. Registrar no equivale a aprovisionar.
- **P1:** el ejecutor real ya existe: falta la UI de suspender/reanudar y el modal de eliminación con la vista previa (`adapter.preview(ctx, {destroy: true})`); la API ya exige `confirm` al eliminar.
- **P3/P5:** añadir sus módulos/pantallas sobre el layout existente y sus rutas en `App.tsx`.
- **P4:** pantalla **Planes** y API `/plans` (ver [Planes](#planes-p4)). Cada tenant guarda la copia del plan con la que se creó y los motores despliegan esa copia.
- **P6:** el ejecutor común y el servicio SSM ya están conectados al flujo de creación de P2 (`src/worker/handlers/create.handler.js`), junto con el health check de P4 y la persistencia de deployments/outputs/versiones. Suspender/reanudar/eliminar conservan los adaptadores de P2 y la finalización protegida por el worker.

H4/H5 ya tienen un [ejecutor común de procesos](platform_api/src/worker/README.md), integrado a los respaldos y a los motores IaC: progreso filtrado, timeout, cancelación del árbol de procesos y errores legibles. La cancelación se detecta también mientras el comando permanece en silencio. El servicio SSM prepara los tres secretos por tenant y conserva los existentes al reintentar.

Para actualizar una base existente, ejecutar `pnpm db:migrate` y reiniciar API y worker. Las migraciones `003_create_deployments.sql` (P6) y `003_engines.sql` (P2) conservan sus archivos y checksums originales. El migrador resuelve su columna compartida si una de las dos ya estaba aplicada; `004_unify_deployments.sql` unifica los estados sin borrar datos. Se prueban tanto una base nueva como la actualización desde cada 003. No borrar tablas ni editar manualmente `schema_migrations`.
- **P1/P2/P6:** el ciclo completo del worker usa Terraform/OpenTofu. El [adaptador y la plantilla de CloudFormation de P2](../infra/cloudformation/README.md) se usan para crear, suspender, reanudar y eliminar con vista previa. La actualización y el cambio de plan con CloudFormation quedan pendientes. Pulumi permite registro en integración. El modo local simula todos los motores.
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
| `GET /plans` | Catálogo con `sizing`, `limits`, `backup`, `description`, `version` y `tenants{total,outdated}` | Sesión |
| `GET /plans/:code` | Plan + `tenant_list` con la versión de cada tenant | Administrador de plataforma |
| `POST /plans` · `PUT /plans/:code` · `DELETE /plans/:code` | Crear, editar (nueva versión; exige la `version` vista) y eliminar si no tiene tenants. Ver [Planes](#planes-p4) | Administrador de plataforma |
| `GET /engines` | Motores del wizard: `{code,label,available}`; `available=false` = aún sin adaptador | Sesión |
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

  Así Terraform y OpenTofu no comparten caché ni lockfile con el checkout ni entre tenants. La caché de proveedores se comparte por motor en `.local/runs/.plugin-cache/`.
- **Estado:** backend S3 del bucket `IAC_STATE_BUCKET`, con la clave `tenants/<tenant_id>/<env>/terraform.tfstate`, `encrypt = true` y `use_lockfile = true` (bloqueo nativo de S3 con `-lock-timeout=5m`). Además, el índice de la cola impide dos operaciones activas del mismo tenant.
- **Entrada:** se arma con:
  - el tenant y **la copia de su plan** (`tenants.plan_snapshot`: `sizing`, `limits` y `backup` de la versión con la que se creó; ver [Planes](#planes-p4));
  - los outputs de la base (`IAC_BASE_OUTPUTS`), generados con `terraform -chdir=infra/terraform/base output -json integration > .local/base.outputs.json`;
  - las AMIs de `infra/packer/ami-ids.json`.

  La primera operación congela base, bucket/clave, plan, límites, respaldos y AMIs en `operations.params.deployment`. Los reintentos y las operaciones de suspensión/reanudación/eliminación conservan esa configuración; cambiar el catálogo o `.env` no debe modificar una instalación parcial. Cambiar plan/AMI requiere un flujo explícito posterior.
- **Secretos:** antes del primer `apply`, el servicio SSM de P6 (`worker/services/tenant-secrets.js`) crea `/tenants/<id>/<env>/{db_password,jwt_secret,admin_password}` como `SecureString`.
  - Si ya existen, se reutilizan y no se reemplazan.
  - Nunca llegan al tfstate, a las variables ni a los eventos; los eventos solo muestran los nombres.
  - La contraseña inicial del administrador del tenant se consulta con `aws ssm get-parameter --with-decryption --name /tenants/<id>/<env>/admin_password`.
- **Logs y errores:** cada línea del CLI se guarda como evento, ya redactado. El error final se traduce a un mensaje comprensible (bloqueo del estado, credenciales, cuota de vCPU, AMIs, permisos o bucket), y el detalle técnico queda en los eventos.
- **Versiones (RF-13):** cada despliegue guarda en `deployments.tool_versions`:
  - el motor y su versión, y la del proveedor AWS;
  - la versión y el commit de las AMIs;
  - el commit de las plantillas (con `-dirty` si había cambios locales).

  También guarda las AMIs, los recursos y los outputs. El detalle del tenant los muestra en el panel **Infraestructura**.
- **Vista previa:** se usa `infra/terraform/plan_preview.py` de P1 si hay Python (`PYTHON_BIN`). Sin Python se continúa con el conteo de `Plan: X to add…`.

### Configurar el worker

1. Instalar Terraform ≥ 1.10 (u OpenTofu ≥ 1.10 para tenants con `engine=tofu`) y, si se quiere la vista previa, Python 3.
2. Dar credenciales AWS al proceso del worker (`AWS_PROFILE` o `AWS_*`). Necesitan permisos sobre el módulo tenant, el bucket del estado y, en `/tenants/*`, `ssm:DescribeParameters`, `ssm:PutParameter` y `ssm:AddTagsToResource`.
3. En `platform_api/.env`, definir `IAC_STATE_BUCKET=<bucket del estado>`. El nombre anterior `DEPLOYMENT_STATE_BUCKET` sigue funcionando como alias. Si se conservan ambos deben coincidir. También se aceptan los aliases anteriores de rutas; no configurar dos valores distintos. Ver `.env.example`.
4. Exportar los outputs de la base a `.local/base.outputs.json` con el comando de arriba.
5. Ejecutar `pnpm db:migrate` (ambas 003 y la reconciliación 004, según lo ya aplicado), reiniciar la API y ejecutar `pnpm worker`.

Para crear la infraestructura de un tenant:

- **Desde la UI:** wizard **Crear tenant** (`/tenants/new`) con la casilla *Crear la infraestructura al confirmar*, o detalle del tenant → **Crear infraestructura**.
- **Desde la API:** `POST /api/v1/tenants/<uuid>/operations` con `{"type":"create"}`.

Para probar sin AWS (terraform simulado): `pnpm test:engines`.
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

## Planes (P4)

Pantalla **Planes** del menú lateral (`/plans`). Muestra cada plan con:

- sus límites de la app (estudiantes, docentes y cursos);
- servidores, disco y respaldo;
- su versión y cuántos tenants lo usan, incluidos los que están en una versión anterior.

El administrador de plataforma puede crear, editar y eliminar planes. Un plan nuevo aparece enseguida en el wizard **Crear tenant**. Catálogo completo, significado de cada límite y reglas: [docs/catalogo-planes.md](../docs/catalogo-planes.md).

- **Versiones (RF-04):** al registrarse, cada tenant guarda una copia del plan vigente (`tenants.plan_snapshot`, la llena un trigger de `004_plans.sql`). Editar un plan sube su versión y **no cambia los tenants existentes**. El editor muestra cuáles son y exige confirmarlo. Los motores despliegan la copia: si un `suspend`/`resume` tomara los límites nuevos, cambiaría el `user_data` y recrearía las EC2. Llevar un tenant a la versión nueva es un cambio de plan (RF-06).
- **Validación:** mismas reglas que el módulo de P1, en la API (zod, con mensajes por campo) y en la base (`CHECK`):
  - tamaños `t3.micro` a `t3.large`;
  - disco de BD entero entre 10 y 1000 GB;
  - respaldo `weekly/28`, `daily/14` o `daily/30`;
  - límites enteros ≥ 1 (vacío = sin límite).
- **Concurrencia:** `PUT` exige la `version` que vio el editor. Si otro guardó antes, responde `409 PLAN_CHANGED`.
- **Eliminar:** solo un plan que ningún tenant usa ni usó; si no, `409 PLAN_IN_USE`.

Migración: `pnpm db:migrate` aplica `004_plans.sql`, que agrega respaldo, descripción y versión a `plans`, `plan_snapshot` a `tenants` y rellena los tenants existentes.

Pruebas contra PostgreSQL real: crean una base desechable `plans_test_*`, aplican todas las migraciones y la borran al terminar. Usa un servidor local donde el usuario pueda crear bases, por ejemplo el de `compose.yaml`; no la base de Supabase del equipo:

```bash
cd platform/platform_api
TEST_DATABASE_URL=postgresql://attendance:attendance_local@127.0.0.1:5433/postgres pnpm test:plans
```

Sin `TEST_DATABASE_URL`, estas pruebas se omiten en `pnpm test`.

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
