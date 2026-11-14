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

- **P2:** integrar su wizard sobre el registro inicial y conectar los adaptadores al worker. Registrar no equivale a aprovisionar. Mantener el bloqueo por tenant y usar su `tenant_id` + `env` para localizar el estado de IaC.
- **P1:** integrar suspensión/reanudación, vista previa y confirmación de eliminación cuando exista el ejecutor real.
- **P3/P4/P5:** añadir sus módulos/pantallas sobre el layout existente y sus rutas en `App.tsx`. El catálogo inicial se consulta desde la API; P4 puede ampliarlo mediante nuevas migraciones y sus endpoints.
- **P6:** completar generación de secretos en SSM, ejecución de motores con timeout/logs, health checks y persistencia de deployments/outputs/versiones. La redacción incluida sirve para eventos; el streaming seguro de procesos externos sigue pendiente.

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
| `POST /tenants/:id/operations` | `{type:"diagnostic"}`; devuelve `202` | Administrador de plataforma |
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

Los errores tienen `{ "error": { "code": "...", "message": "..." } }`; la validación puede añadir `fields`. Una segunda operación activa devuelve `409 TENANT_BUSY`. Los logs devuelven `{items,next_cursor,has_more}`; usar el cursor siguiente para evitar duplicados. El frontend consulta el progreso mediante polling. Todavía no se implementaron las rutas reales de crear infraestructura, suspender, reanudar, eliminar o respaldar.

La cola reclama trabajos con transacciones y `FOR UPDATE SKIP LOCKED`. Un índice único impide más de un trabajo activo por tenant, incluso entre procesos. El heartbeat identifica al worker dueño de cada trabajo. Se admite cancelar y reintentar el diagnóstico; el reintento de IaC deberá reconciliar el estado existente antes de ejecutar de nuevo.

## Verificación

```bash
cd platform/platform_api
pnpm test
```

Para integración usa una base **desechable cuyo nombre empiece por `platform_test`**. La prueba elimina sus tablas; no carga `.env` y exige `TEST_DATABASE_URL` explícita. Por ejemplo, con el PostgreSQL local del compose, desde la raíz:

```bash
docker compose -f platform/compose.yaml exec postgres createdb -U attendance platform_test
cd platform/platform_api
TEST_DATABASE_URL=postgresql://attendance:attendance_local@127.0.0.1:5433/platform_test pnpm test:integration
```

Siete pruebas unitarias y diez de integración verificadas con PostgreSQL 16: sesiones persistentes, logout/expiración, bootstrap repetible, permisos entre instituciones, validación, peticiones/workers simultáneos, eventos por cursor, cancelación y recuperación/reintento de trabajos interrumpidos.

Frontend, desde `platform/platform_web/`:

```bash
pnpm lint
pnpm build
```

Referencias: [Express](https://expressjs.com/en/guide/writing-middleware/), [transacciones de node-postgres](https://node-postgres.com/features/transactions), [colas con SKIP LOCKED](https://www.postgresql.org/docs/16/sql-select.html).
