# Plataforma de administración — P6

Usamos el frontend React/Vite inicializado en `platform_web/`. `platform_api/` es un backend **Node.js + Express, en JavaScript**, con PostgreSQL. La API y el worker se ejecutan como procesos separados y comparten código y base de datos. No hace falta Redis.

Esta base permite iniciar sesión, conservar la sesión al recargar, registrar/listar/consultar instituciones y ejecutar un diagnóstico con progreso, eventos, cancelación y reintento. Registrar una institución **no despliega servidores**. El diagnóstico tampoco llama a AWS. Falta conectar los adaptadores reales de P2, SSM y las comprobaciones de salud del despliegue.

## Arrancar en local

Requisitos: Node.js 22.13 o superior (recomendado 24), pnpm y PostgreSQL 16. Todos los comandos parten de la raíz del repositorio, salvo donde se indica.

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
pnpm install
cp .env.example .env
```

Edita `.env`:

- `DATABASE_URL`: conexión de la base nueva de la plataforma.
- `DB_SSL=true` si la conexión lo requiere; se verifica el certificado por defecto.
- `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD`: cuenta inicial de la plataforma, con contraseña de 12–128 caracteres. No son las credenciales del administrador de cada instalación de Attendance.
- `CLIENT_ORIGIN`: `http://localhost:5173`, que será la dirección del frontend.

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

### 4. Frontend (otra terminal)

Desde la raíz:

```bash
cd platform/platform_web
pnpm install
pnpm dev
```

Abre **http://localhost:5173** e ingresa con el administrador que configuraste. Vite reenvía `/api` al backend, con cookies incluidas. No se guarda la contraseña ni un token en localStorage. La sesión dura ocho horas por defecto y se invalida al cerrar sesión. Si necesitas cambiar el destino del proxy, copia el `.env.example` del frontend y ajusta `PLATFORM_API_TARGET`.

Para comprobar el flujo: registrar institución → abrir su detalle → ejecutar diagnóstico → consultar progreso y eventos → recargar la página. El estado seguirá siendo **Sin desplegar**, porque aún no se creó infraestructura.

## Organización para el equipo

```text
platform_api/
  migrations/                 Tablas y catálogo inicial
  scripts/                    Migraciones y administrador inicial
  src/modules/auth/          Sesiones y permisos
  src/modules/tenants/       Registro, filtros y detalle
  src/modules/operations/    Cola, consultas y eventos
  src/worker/                Proceso que reclama y ejecuta trabajos
  src/engines/               EngineAdapter, Terraform/OpenTofu, secretos SSM y health checks (P2)
  src/modules/provisioning/  Operaciones create/suspend/resume/destroy del worker (P2)
  src/db/                    Conexiones y transacciones
  src/lib/                   Errores, contraseñas y redacción de logs
platform_web/src/
  features/auth/             Contexto, hooks, servicios y login
  features/tenants/          Listado, registro y detalle
  features/operations/       Progreso, eventos y acciones
  components/                Layout y componentes compartidos
  hooks/                     Consulta/refresco de datos
  lib/                       Cliente HTTP
```

- **P2:** adaptadores Terraform/OpenTofu conectados al worker (operaciones `create`, `suspend`, `resume`, `destroy`; ver [Motores IaC](#motores-iac-p2)). Pendiente: wizard de 3 pasos, Pulumi y CloudFormation. Registrar no equivale a aprovisionar.
- **P1:** el ejecutor real ya existe: falta la UI de suspender/reanudar y el modal de eliminación con la vista previa (`adapter.preview(ctx, {destroy: true})`); la API ya exige `confirm` al eliminar.
- **P3/P4/P5:** añadir sus módulos/pantallas sobre el layout existente y sus rutas en `App.tsx`. El catálogo inicial se consulta desde la API; P4 puede ampliarlo mediante nuevas migraciones y sus endpoints.
- **P6:** el ejecutor común y el servicio SSM ya están conectados al flujo de creación de P2 (`src/modules/provisioning/`), junto con los health checks y la persistencia de deployments/outputs/versiones.

H4/H5 ya tienen un [ejecutor común de procesos](platform_api/src/worker/README.md), integrado a los respaldos y a los motores IaC: progreso filtrado, timeout, cancelación del árbol de procesos y errores legibles. La cancelación se detecta también mientras el comando permanece en silencio. El servicio SSM prepara los tres secretos por tenant y conserva los existentes al reintentar.

Las tablas iniciales son `users`, `sessions`, `plans`, `tenants`, `operations`, `operation_events` y `deployments`. Las contraseñas se guardan con scrypt; en sesiones solo se conserva el hash del token. No hay registro público de usuarios. Se contempla `tenant_admin` para lectura limitada a su institución; falta su pantalla/flujo de alta. Auditoría, alertas y escáneres se integrarán en sus bloques respectivos. RF-04/05/06/15/19/20 siguen siendo opcionales.

## Contrato de API inicial

Prefijo: `/api/v1`. Los cuerpos son JSON y la autenticación usa la cookie HttpOnly `platform_session`. Para otro cliente HTTP, conservar la cookie entre solicitudes. Las solicitudes desde el navegador deben provenir de `CLIENT_ORIGIN`.

| Método y ruta | Función | Acceso |
| --- | --- | --- |
| `GET /health` | Conectividad de API/PostgreSQL | Público |
| `POST /auth/login` | `{email,password}`; crea sesión | Público, con límite de intentos |
| `GET /auth/me` | Usuario actual | Sesión |
| `POST /auth/logout` | Invalida sesión | Sesión |
| `GET /plans` | Catálogo inicial | Sesión |
| `GET /tenants` | `q`, `status`, `env`, `plan`, `limit`, `offset` | Sesión, filtrado por permisos |
| `POST /tenants` | Registrar institución, sin desplegar | Administrador de plataforma |
| `GET /tenants/:id` | Datos, últimas 20 operaciones y 10 despliegues | Sesión, filtrado por permisos |
| `GET /tenants/:id/backups` | Respaldos del tenant (dumps S3 + snapshots EBS), consultados en AWS al momento | Sesión, filtrado por permisos |
| `POST /tenants/:id/operations` | `{type:"diagnostic"}`, `{type:"backup"}`, `{type:"restore",backup_id:"<id>|latest"}`, `{type:"create"}`, `{type:"suspend"}`, `{type:"resume"}` o `{type:"destroy",confirm:"<tenant_id>"}`; devuelve `202` | Administrador de plataforma |
| `GET /operations/:id` | Estado, etapa y porcentaje | Sesión, filtrado por permisos |
| `GET /operations/:id/logs?after=0` | Eventos por cursor | Sesión, filtrado por permisos |
| `POST /operations/:id/cancel` | Cancelar trabajo en cola/en curso | Administrador de plataforma |
| `POST /operations/:id/retry` | Nuevo trabajo vinculado al fallido/cancelado | Administrador de plataforma |

Las rutas usan el **`id` UUID** de la base de la plataforma. `tenant_id`, por ejemplo `san-marcos`, es el identificador estable que se pasa a IaC; la pareja `(tenant_id, env)` es única. No intercambiar ambos identificadores.

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

Los errores tienen `{ "error": { "code": "...", "message": "..." } }`; la validación puede añadir `fields`. Una segunda operación activa devuelve `409 TENANT_BUSY`. Los logs devuelven `{items,next_cursor,has_more}`; usar el cursor siguiente para evitar duplicados. El frontend consulta el progreso mediante polling. Crear, suspender, reanudar y eliminar la infraestructura funcionan con Terraform/OpenTofu: ver [Motores IaC](#motores-iac-p2). Respaldar y restaurar: ver [Respaldos](#respaldos-p3).

La cola reclama trabajos con transacciones y `FOR UPDATE SKIP LOCKED`. Un índice único impide más de un trabajo activo por tenant, incluso entre procesos. El heartbeat identifica al worker dueño de cada trabajo y consulta la cancelación aunque no haya logs. Al perder la propiedad, se detiene el proceso local sin sobrescribir al nuevo dueño. Se admite cancelar y reintentar cualquier operación. El reintento de IaC vuelve a planificar sobre el mismo estado del tenant: completa lo pendiente sin duplicar recursos.

## Motores IaC (P2)

El worker crea y administra la infraestructura de cada tenant con el motor elegido al registrarlo. Todos los motores implementan la misma interfaz `EngineAdapter` (`src/engines/adapter.js`): `versions`, `preview`, `apply`, `suspend`, `resume`, `destroy` y `outputs`. Todos devuelven el resultado común `{status, resources, outputs{urls,instance_ids,private_ips}, tool_versions, log_ref}`. Hoy están conectados **Terraform** y **OpenTofu**, que ejecutan el módulo [`infra/terraform/tenant`](../infra/terraform/tenant/README.md) de P1. Pulumi y CloudFormation aparecen en el registro, pero la API rechaza sus operaciones con `409 ENGINE_NOT_AVAILABLE` hasta que tengan adaptador.

| Operación | Estados admitidos | Resultado | Qué hace |
| --- | --- | --- | --- |
| `create` | `draft`, `failed` | `ready` | Secretos en SSM → `init` → `plan` → `apply` → outputs → health checks → `deployments` |
| `suspend` | `ready`, `failed` | `suspended` | `apply` con `suspended=true`: detiene las 3 EC2 y conserva los discos |
| `resume` | `suspended`, `failed` | `ready` | `apply` con `suspended=false`, health checks y URLs nuevas (la IP pública cambia) |
| `destroy` | todos menos `deleted` | `deleted` | `plan -destroy` → `apply`. Exige `confirm` igual al `tenant_id` (RF-18) |

Los comandos se ejecutan con el [ejecutor común de P6](platform_api/src/worker/README.md) y los secretos los prepara su servicio SSM. Durante la operación el tenant pasa por `provisioning`, `suspending`, `resuming` o `deleting`. Si falla o se cancela queda en `failed`, y **Reintentar** vuelve a planificar sobre el mismo estado sin duplicar recursos (RF-12).

- **Revisión del plan:** antes de aplicar se revisa el plan. Si una operación que no es `destroy` fuera a borrar el disco de datos de PostgreSQL, se detiene sin aplicar.
- **Cancelar:** durante el `apply`, la cancelación (`OperationCancelled`) se atiende al terminar ese paso, para no dejar el estado a medias. En cualquier otro paso corta el proceso de inmediato.
- **Perder la operación o apagar el worker:** sí corta el `apply`. En Linux/macOS terraform recibe SIGTERM y tiene 60 s para terminar y liberar el bloqueo; en Windows se usa `taskkill /F`. Si el bloqueo queda tomado, hay que revisarlo con `force-unlock` antes de reintentar.

### Cómo se ejecuta y dónde queda el estado

- **Directorio por tenant:** `.local/runs/<tenant_id>/<env>/` (fuera de Git) guarda:
  - una copia de los `.tf` del módulo, que se refresca en cada operación;
  - su propio `.terraform/`;
  - `tenant.tfvars.json`, `backend.hcl` y el plan temporal.

  Así Terraform y OpenTofu no comparten caché ni lockfile con el checkout ni entre tenants. La caché de proveedores se comparte por motor en `.local/runs/.plugin-cache/`.
- **Estado:** backend S3 del bucket `IAC_STATE_BUCKET`, con la clave `tenants/<tenant_id>/<env>/terraform.tfstate`, `encrypt = true` y `use_lockfile = true` (bloqueo nativo de S3 con `-lock-timeout=5m`). Además, el índice de la cola impide dos operaciones activas del mismo tenant.
- **Entrada:** se arma con:
  - el tenant y su plan (`plans.sizing` y `limits`, y respaldo semanal o diario según el plan);
  - los outputs de la base (`IAC_BASE_OUTPUTS`), generados con `terraform -chdir=infra/terraform/base output -json integration > .local/base.outputs.json`;
  - las AMIs de `infra/packer/ami-ids.json`.
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
3. En `platform_api/.env`, definir `IAC_STATE_BUCKET=<bucket del estado>`. Las demás variables tienen valores por defecto (ver `.env.example`).
4. Exportar los outputs de la base a `.local/base.outputs.json` con el comando de arriba.
5. Ejecutar `pnpm db:migrate` (aplica `003_engines.sql`) y luego `pnpm worker`.

Para crear la infraestructura de un tenant:

- **Desde la UI:** detalle del tenant → **Crear infraestructura**.
- **Desde la API:** `POST /api/v1/tenants/<uuid>/operations` con `{"type":"create"}`.

Para probar sin AWS (terraform simulado): `pnpm test:engines`.

## Respaldos (P3)

Pantalla **Respaldos** del menú lateral (`/backups?tenant=<id>`): lista los respaldos del tenant, «Respaldar ahora» y «Restaurar» (confirma escribiendo el `tenant_id`). Respaldar y restaurar son operaciones de la cola (`backup`/`restore`, migración `002_backups.sql`): heredan el bloqueo por tenant, los eventos, la cancelación y el reintento. El worker ejecuta `infra/backups/tenant-backup.sh`, que usa AWS CLI con las credenciales del proceso del worker (perfil `default` o variables `AWS_*`), y guarda su JSON final en `operations.result`. El listado (`GET /tenants/:id/backups`) llama al mismo script con `list`.

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `BACKUP_BASH` | `bash`; en Windows `C:\Program Files\Git\bin\bash.exe` | Bash que ejecuta el script. En Windows usar Git Bash, no el de WSL (no ve las credenciales de AWS de Windows) |
| `BACKUP_SCRIPT` | `infra/backups/tenant-backup.sh` del repositorio | Ruta del script |
| `BACKUP_TIMEOUT_S` | `900` | Tiempo máximo del comando en la VM db |

Requiere AWS CLI v2, la VM db del tenant encendida y AMIs ≥ 0.2.1. El proceso hijo no recibe `DATABASE_URL` ni los secretos de la plataforma. Cancelar corta el script local; un comando que ya llegó a la VM db termina allí. Pruebas sin AWS: `pnpm test:backups`.

## Verificación

```bash
cd platform/platform_api
pnpm test
```

La suite actual contiene 33 pruebas: ejecutor de procesos, filtrado de secretos, respaldos de P3, cancelación/propiedad del worker y preparación de SSM. Usa procesos ficticios, un doble de conexión y un cliente SSM simulado; no carga `.env`, no conecta a AWS ni modifica PostgreSQL. Incluye hijos que ignoran SIGTERM, cancelación sin logs, fallo parcial de secretos y reintentos sin cambiar credenciales. Ver [el contrato del ejecutor y las pruebas](platform_api/src/worker/README.md).

La comprobación de SQL, sesiones y permisos contra PostgreSQL real requiere su propia prueba de integración; el script `test:integration` no está disponible en este checkout. No ejecutar pruebas destructivas sobre la base de Supabase usada por el equipo.

Frontend, desde `platform/platform_web/`:

```bash
pnpm lint
pnpm build
```

Referencias: [Express](https://expressjs.com/en/guide/writing-middleware/), [transacciones de node-postgres](https://node-postgres.com/features/transactions), [colas con SKIP LOCKED](https://www.postgresql.org/docs/16/sql-select.html).
