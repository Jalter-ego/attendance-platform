# Catálogo de planes y límites — P4 (J2 · F1–F4 · RF-01/02/04/05)

Un **plan** define la capacidad de una institución:

- **cómputo y disco**: tamaño de las 3 EC2 y del EBS de PostgreSQL;
- **límites de uso**: los hace cumplir la app de asistencia;
- **respaldo**: frecuencia y retención.

Se administra en la pantalla **Planes** de la plataforma. Cada institución conserva la versión del plan con la que se creó.

## 1. Catálogo inicial (semilla, versión 1)

| | **Básico** (`basic`) | **Estándar** (`standard`) | **Avanzado** (`advanced`) |
|---|---|---|---|
| Para | Instituciones pequeñas | Instituciones en crecimiento | Alta demanda |
| Estudiantes máx. | 100 | 1.000 | 5.000 |
| Docentes máx. | 10 | 50 | 200 |
| Cursos máx. | 20 | 100 | 500 |
| Frontend | t3.micro | t3.micro | t3.small |
| Backend | t3.micro | t3.small | t3.medium |
| Base de datos | t3.micro | t3.small | t3.medium |
| Disco de BD (EBS cifrado) | 10 GB | 50 GB | 200 GB |
| Respaldo | Semanal · 28 días | Diario · 14 días | Diario · 30 días |

Fuente: §8 del plan de implementación. La semilla está en `platform/platform_api/migrations/001_platform.sql` (tamaños y límites, P6) y `004_plans.sql` (respaldo, descripción y versión, P4). La app no guarda archivos, así que el "almacenamiento" de un plan es el disco de la base.

## 2. Qué significa cada límite en la app

`attendance-core` no tiene "docentes" ni "cursos" como entidades propias. Los límites se aplican así (`src/plan/`):

| Límite | Variable en la VM | Qué cuenta | Cuándo se comprueba |
|---|---|---|---|
| `max_students` | `PLAN_MAX_STUDENTS` | Estudiantes de los módulos no archivados (borrador o activos) | Al importar el Excel de un módulo, dentro de la misma transacción: los demás módulos más las filas del archivo (el borrador del mismo módulo se reemplaza, no se suma) |
| `max_teachers` | `PLAN_MAX_TEACHERS` | Usuarios activos, incluido el administrador (owner) | Al crear un usuario activo y al reactivar uno |
| `max_courses` | `PLAN_MAX_COURSES` | Módulos académicos en borrador o activos | Al crear un módulo |

- **Si se supera**, responde `403` con un mensaje que el frontend ya muestra: *"Tu plan Básico permite hasta 100 estudiantes (esta acción llegaría a 120). Para ampliar el límite, solicita un cambio de plan."*
- **Sin la variable**, o con un valor vacío, no hay límite.
- **Con un valor inválido** (que no sea un entero positivo), la API **no arranca**. El arranque queda `failed` en lugar de dejar una institución sin límites.
- **Archivar un módulo** libera sus cursos y estudiantes.
- **`GET /core/api/v1/plan/usage`** (administrador de la institución) devuelve el uso frente a cada límite y el nombre del plan. Sirve para la demo y para soporte.

## 3. Del catálogo a la VM

```
plans (catálogo, editable)               pantalla Planes · API /plans (P4)
   │  al registrar la institución (trigger de 004_plans.sql)
   ▼
tenants.plan_snapshot  {code, name, version, sizing, limits, backup}
   │  create / suspend / resume (worker, P2): buildTenantInput usa la COPIA
   ▼
motor IaC (Terraform/OpenTofu/CloudFormation)
   ├─ sizing  → tipos de EC2 y tamaño del EBS
   ├─ backup  → etiqueta DLM BackupPolicy=<proyecto>:<frecuencia>-<días>d + backup.env de la VM db (P3)
   └─ limits  → user_data → /etc/attendance/tenant.json
                  └─ boot_backend (Ansible) → backend.env: PLAN_MAX_STUDENTS/TEACHERS/COURSES, TENANT_PLAN
                       └─ attendance-core aplica los límites (403) y expone /plan/usage
```

## 4. Reglas de un plan

Son las del módulo `infra/terraform/tenant` (P1). La API las valida con mensajes legibles y la base las repite como restricciones (`004_plans.sql`).

| Campo | Regla |
|---|---|
| `code` | `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`. No se cambia: lo usan la etiqueta `Plan` de AWS y `TENANT_PLAN` |
| `sizing.frontend/backend/db` | `t3.micro`, `t3.small`, `t3.medium` o `t3.large` (AMIs x86_64 de P3) |
| `sizing.db_disk_gb` | Entero de 10 a 1000. El módulo solo exige ≥ 10; el tope evita un disco caro por error |
| `limits` | Solo `max_students`, `max_teachers` y `max_courses`, enteros ≥ 1. Una clave ausente = sin límite |
| `backup` | `weekly/28`, `daily/14` o `daily/30`: las políticas DLM y de vencimiento S3 de la base (P3/P1) |

## 5. Versiones: editar un plan no cambia las instituciones existentes (RF-04)

- **Al registrarse**, cada institución guarda una copia del plan vigente (`tenants.plan_snapshot`). Los motores despliegan esa copia, no el plan actual.
- **Al editar un plan** sube su versión (`v1 → v2`). La pantalla muestra qué instituciones lo usan y exige confirmar que **no se modifican**. La versión nueva aplica a las que se registren desde entonces.
- **Por qué:** los límites viajan en el `user_data` y el módulo tiene `user_data_replace_on_change`. Si un `suspend`/`resume` tomara el plan editado, **recrearía las EC2** de esa institución sin aviso.
- **Llevar una institución a la versión nueva** es un **cambio de plan** (RF-06, con vista previa de P1/P2), porque puede redimensionar o recrear sus servidores. A nivel de datos: cambiar `tenants.plan`, o poner `plan_snapshot = NULL` para tomar la versión vigente del mismo plan; el trigger rellena la copia.
- **Eliminar un plan** solo se permite si ninguna institución lo usa ni lo usó.
- La API rechaza con `409` una edición basada en una versión vieja (dos administradores editando a la vez).

## 6. API (platform_api)

| Método | Ruta | Quién | Respuesta |
|---|---|---|---|
| GET | `/api/v1/plans` | Cualquier sesión (el wizard la usa) | `{items: [{code, name, description, sizing, limits, backup, version, tenants: {total, outdated}}]}` |
| GET | `/api/v1/plans/:code` | Admin de plataforma | El plan + `tenant_list` con la versión de cada institución |
| POST | `/api/v1/plans` | Admin de plataforma | `201` con el plan creado. Código repetido → `409` |
| PUT | `/api/v1/plans/:code` | Admin de plataforma | Cuerpo completo + `version` vista. `{plan, changed, unchanged_tenants, warning}`. Versión vieja → `409 PLAN_CHANGED` |
| DELETE | `/api/v1/plans/:code` | Admin de plataforma | `204`. En uso → `409 PLAN_IN_USE` |

Los errores de validación devuelven `400 VALIDATION_ERROR` con `fields[]`, por ejemplo: `backup: Respaldo permitido: semanal con 28 días, diario con 14 días o diario con 30 días.`

## 7. Pruebas

| Dónde | Qué |
|---|---|
| `platform/platform_api/tests/plans.test.js` | API y migración contra PostgreSQL real (`TEST_DATABASE_URL=… pnpm test:plans`): semilla, crear, validaciones, copia al registrar, **editar no cambia la entrada del motor de una institución existente**, `409` por versión vieja, eliminar y permisos |
| `attendance-core` (`pnpm test`) | Límites de estudiantes, docentes y cursos, `/plan/usage` y el arranque con valores inválidos |
| `infra/ansible/tests/update/e2e.sh` | `boot_backend` escribe `PLAN_MAX_*` en `backend.env` con la app real |
| `attendance-core/docs/postman/attendance-core-plan-limits.postman_collection.json` | Paso a paso de los `403` del plan contra una instalación |
