# Contribuciones

Quién hizo qué en Tenant Control Center, como apoyo para la defensa individual (tarea J8 del
[plan](docs/Plan_de_implementacion_Tenant_Control_Center.md#4-reparto-del-equipo-6-personas)).
Cada integrante completa **su propia sección**: tareas, archivos que defiende, PRs y cómo lo verificó.
Los commits y PRs llevan el autor real.

| Rol | Integrante | Eje (herramienta de la materia) | Pantallas | Suplente |
| --- | --- | --- | --- | --- |
| P1 | Jhon Said Andia Merino (GitHub `Jalter-ego`) | Terraform/OpenTofu, estado, red y permisos | Integración de acciones de infraestructura y auditoría con P6 | P2 |
| P2 | GitHub `Arlin-Ab` | **Motores IaC: EngineAdapter, Terraform/OpenTofu, Pulumi, CloudFormation** | Crear tenant (wizard), panel Infraestructura | P1 |
| P3 | jorge (GitHub `Gatu-1548`) | **Packer · cloud-init · Respaldos** | Respaldos | P4 |
| P4 | Marcelo (GitHub `MarceloCamachh`) | **Ansible · app del tenant · planes** | Planes | P3 |
| P5 | _por completar_ | Observabilidad · escáneres de seguridad | Inicio, Monitoreo, Seguridad | P6 |
| P6 | Sebastián (GitHub `Sebastian-M-C`) | Plataforma: API · worker · auditoría | Login, shell, Tenants, progreso y logs; integración del panel | P5 |

---

## P1 — Terraform/OpenTofu · Estado y secretos (Jhon Said Andia Merino)

**Tareas:** A1–A7, C1–C7, B7 con P3, arquitectura con P2 y coordinación de entrega.
C5/RF-06 se conserva como opcional según lo acordado por el equipo.

### Qué hice

| Bloque | Resultado y archivos que defiendo |
| --- | --- |
| **A1 — Organización y secretos** | Estructura del monorepo, contratos de integración, `.gitignore` y hook `.githooks/pre-commit`. `scripts/setup-secrets.py` instala Gitleaks oficial con checksum y activa el hook por clon. |
| **A2 — Cuota y presupuesto** | Cuota regional consultada: 16 vCPU Standard On-Demand en Ohio. `infra/terraform/base/costs.tf` administra el presupuesto mensual opcional; la cuenta del responsable quedó con 10 USD y avisos al superar 80/100 %. El correo está en variables locales. |
| **A3 — Estado compartido** | `infra/bootstrap/`: S3 cifrado, versionado, acceso público bloqueado, TLS y protección contra eliminación. Claves separadas para bootstrap, base y cada tenant/entorno; bloqueo S3 nativo. |
| **A4 — SSM/IAM** | Perfiles y políticas de `infra/terraform/tenant/iam.tf`, limitados al prefijo del tenant. P6 genera los SecureString fuera del IaC; P3/P4 los consumen al arrancar. Frontend no puede leer los secretos de backend/DB. |
| **A5 — Capa compartida** | VPC, subred pública/privada, rutas, SG, endpoints privados SSM/S3, bucket de respaldos/DLM y EC2 de monitoreo desde AMI de P3. Administración por SSM y salida pública de integración. Dashboards y alertas corresponden a P5. |
| **A6/J1 — Contrato y arquitectura** | `docs/contratos-integracion.md`, `docs/arquitectura-p1.md` y los README de los módulos explican el estado por motor y el flujo de creación. |
| **A7 — Control de pruebas** | `scripts/test-costs.mjs`: lista, suspende y elimina tenants test por la API, con revisión predeterminada, guardas de entorno y vista previa/confirmación al eliminar. Conserva la coherencia del estado de cada motor. |
| **B7/C1/C2 — Módulo tenant** | Tres EC2 desde AMIs por rol, SG, IAM, EBS de PostgreSQL, tamaños/límites/respaldos recibidos del plan, etiquetas y outputs de IDs/IP/URL. Contrato coordinado con P2, P3 y P4. |
| **C3 — Ciclo de energía** | `lifecycle.tf`: detener/arrancar mediante `suspended`, conservar EC2/EBS y recalcular las URLs después del arranque. Se corrigió también en monitoreo el reemplazo indebido por la IP pública al detener. |
| **C4 — Vista previa** | `infra/terraform/plan_preview.py`: resumen legible/JSON, reemplazos, interrupciones y advertencia de pérdida de datos, respetando campos sensibles. P2/P6 lo integran con las operaciones. |
| **C6 — OpenTofu** | Mismo HCL y proveedor; `infra/terraform/check_engines.py` comprueba compatibilidad sin mutar el checkout ni migrar el backend compartido. |
| **C7 — Recuperación y bloqueo** | Estado por tenant, reintento conservando identidad/configuración y `scripts/verify-state-lock.py`, una prueba real de exclusión e idempotencia sobre una clave S3 aislada sin EC2. |

Los permisos administradores de los integrantes fueron una decisión explícita del
responsable para este laboratorio. Las identidades IAM de las EC2 siguen separadas
y restringidas; no se presenta el acceso humano como un ejemplo de mínimo privilegio.

### Integración y verificación

- Apoyo inicial a la base de API/worker y resolución de conflictos de integración;
  el desarrollo actual de P6 y los adaptadores de P2 se atribuyen a sus responsables.
- Creación desde la web, login de Attendance, suspensión y eliminación reales
  confirmados por el responsable en su cuenta AWS.
- Pruebas previas documentadas: 2 de bootstrap, 11 de base y 13 de tenant por motor,
  además de 14 comprobaciones de la vista previa. Son pruebas con AWS simulado.
- Cierre del 15/11: ocho pruebas de las guardas del control de costos, listado real
  de la plataforma, Gitleaks sin hallazgos sobre archivos versionados/nuevos no ignorados,
  cuota consultada, presupuesto aplicado y bloqueo real S3 con dos procesos.
- Creación independiente de `p6-check-terraform-mwi1p0zu/test`: tres EC2 y health checks
  aprobados con Terraform 1.16.6, proveedor 6.69.1 y AMIs 0.2.2. El ciclo adicional de
  datos y su limpieza quedan pendientes; la instalación de prueba sigue activa.
- El resultado detallado del ciclo EC2/EBS y los límites de la evidencia se registran
  en `docs/evidencias-p1.md`; una simulación no se presenta como una prueba real.

### Entrega y video

Manual: `docs/manual/p1-infraestructura.md`. Arquitectura: `docs/arquitectura-p1.md`.
Guion individual de dos minutos: `docs/video-p1.md`. Se conserva el plan original
y se anotan avances sin reescribir el reparto. El documento Google de entrega
se revisó únicamente en lectura; completar nombres y enlace del video corresponde al equipo.

## P2 — Motores IaC · Adaptador multi-motor · Wizard (GitHub `Arlin-Ab`)

**Tareas del plan:** D1–D7, A6 (con P1), J1 (con P1) y el wizard Crear tenant. Avance en curso: esta sección se actualiza con cada PR.

### Qué hice

| Tarea | Resultado |
| --- | --- |
| **D1** Interfaz `EngineAdapter` | `platform/platform_api/src/engines/adapter.js`: `versions`, `preview`, `apply`, `suspend`, `resume`, `destroy`, `outputs`, con el resultado común del contrato `{status, resources, outputs, tool_versions, log_ref}`. El worker solo habla con esta interfaz. |
| **D2** Adaptadores Terraform y OpenTofu | `src/engines/terraform.js` ejecuta el módulo `infra/terraform/tenant` de P1. Usa un directorio por tenant con copia del módulo, `.terraform/` y lockfile propios, backend S3 `tenants/<id>/<env>/terraform.tfstate` con `use_lockfile` y el flujo `init → plan → revisión → apply → output`. Si el plan borraría el disco de datos fuera de un `destroy`, se detiene. |
| Conexión al worker | `src/modules/provisioning/`: operaciones `create`, `suspend`, `resume` y `destroy` en la cola de P6 (migración `003_engines.sql`), con estados del tenant, health checks después del apply, reintento sin duplicar (RF-12) y confirmación al eliminar (RF-18). |
| Errores comprensibles (RF-11) | Los comandos corren con el ejecutor común de P6 (`worker/services/command-runner.js`). `src/engines/errors.js` traduce los errores conocidos (bloqueo, credenciales, cuota de vCPU, AMIs, permisos, bucket) a partir de stderr. Cancelar desde la UI no corta un `apply` a medias; perder la operación sí lo detiene. |
| Secretos | El handler `create` llama al servicio SSM de P6 (`worker/services/tenant-secrets.js`) antes del primer apply; los eventos solo muestran nombres. |
| **Wizard Crear tenant** (RF-03, RF-07) | `platform_web/src/features/tenants/pages/CreateTenantPage.tsx`, en `/tenants/new` y basado en el mockup del PDF:<br>• **Datos y plan:** tarjetas de plan con límites y respaldo, selector de motor, e identificador generado desde el nombre.<br>• **Configuración:** zona horaria, servidores con sus tamaños, límites y respaldo.<br>• **Revisión:** lo que se creará en AWS, con opción de crear la infraestructura al confirmar.<br>• Resumen lateral en vivo y validación por paso. Los motores sin adaptador quedan como "solo registro".<br>API: `GET /engines` y `backup` en `GET /plans`. Reemplaza al formulario de registro anterior. |
| **D4/D5** CloudFormation | `infra/cloudformation/tenant.yaml`: el mismo stack que el módulo Terraform (3 EC2 con IMDSv2, EBS cifrado, SG por rol, IAM limitado al prefijo SSM, respaldos opcionales), un stack por tenant.<br>`src/engines/cloudformation.js` (SDK de AWS):<br>• change sets como vista previa, con bloqueo si se perdería el disco de datos;<br>• eventos del stack como logs y error tomado del primer recurso fallido;<br>• reintento que limpia `ROLLBACK_COMPLETE`;<br>• **D5:** suspender y reanudar con la API de EC2.<br>Documentado en `infra/cloudformation/README.md`. |
| **D3** Pulumi | `infra/pulumi/tenant`: programa en JavaScript con el mismo stack (recursos, nombres, reglas, etiquetas `ManagedBy=pulumi` y precondiciones de red), disco de datos con `protect`.<br>`src/engines/pulumi.js`:<br>• un stack por tenant en `s3://<bucket>/pulumi`, con bloqueo y cifrado (`PULUMI_SECRETS_PROVIDER`);<br>• configuración por stdin;<br>• `preview --json` con bloqueo si se perdería el disco de datos, `up` y outputs;<br>• suspender y reanudar declarativos (`InstanceState`);<br>• eliminar con huella de la vista previa y `state unprotect`.<br>Integrado en el flujo de P6 (`worker/services/pulumi-lifecycle.js`). Documentado en `infra/pulumi/README.md`. |
| **D7** Registro de versiones (RF-13) | Cada despliegue guarda en `deployments` el motor y su versión, el proveedor AWS, la versión y el commit de las AMIs, el commit de las plantillas, las AMIs, los recursos y los outputs. Se ve en el panel **Infraestructura** del detalle del tenant. |

### Cómo lo verifiqué

- `pnpm test:engines`: 15 pruebas sin AWS, con terraform simulado (`tests/fixtures/fake-terraform.mjs`). Cubren la entrada común, el directorio y backend por tenant, el resultado y las versiones, la suspensión, el reintento sin cambios, los errores legibles, la cancelación y la pérdida de la operación durante el apply, y los health checks. Junto con las de P3/P6: 48 pruebas, 0 fallos.
- Flujo completo contra PostgreSQL 16 real con las migraciones 001–003:
  - un `create` que falla, queda `failed`, se reintenta y termina `ready`;
  - `suspend` → `suspended`, `resume` → `ready`;
  - tres `deployments` con versiones;
  - `destroy` rechazado sin confirmación y aceptado con ella.
- Terraform 1.16.6 real (sin AWS) acepta las variables que genera el adaptador con el módulo copiado (`validate` y `console`), incluida la plantilla cloud-init por ruta absoluta.
- `pnpm lint` y `pnpm build` del frontend.
- Wizard recorrido en Edge con Playwright, contra la API y PostgreSQL reales:
  - validación por paso;
  - identificador sin tildes (`Colegio Simón Bolívar` → `colegio-simon-bolivar`);
  - el resumen refleja el plan;
  - con Terraform, crear deja la operación `create` en cola;
  - con CloudFormation, solo registra;
  - un identificador repetido muestra el error de la API;
  - a 390 px no hay scroll horizontal.

- CloudFormation: `cfn-lint` sin hallazgos y `pnpm test:cloudformation` (10 pruebas con AWS simulado: crear, sin cambios, bloqueo por pérdida de datos, error legible, reintento tras `ROLLBACK_COMPLETE`, suspender/reanudar por EC2, eliminar, validación de AMIs).

- Pulumi:
  - `pnpm --dir infra/pulumi/tenant test`: 7 pruebas con los mocks de Pulumi. Cubren los recursos y las reglas, el user data igual a la plantilla de P3, la suspensión, la ausencia de bucket de respaldos y las validaciones.
  - `pnpm test:pulumi`: 11 pruebas del adaptador con un CLI simulado.
  - Integración con PostgreSQL real: ciclo crear → suspender → reanudar → vista previa → eliminar desde la API.
  - Prueba de humo con Pulumi 3.272 real y un backend `file://`: crea el stack y ejecuta el programa hasta el proveedor AWS.

- **AWS real desde el panel (15/11/2026):** un tenant por motor con Terraform, CloudFormation y Pulumi, en una cuenta propia con bucket de estado, red base y AMIs 0.3.0 nuevas. Los tres crearon el tenant sano en unos 5 minutos, suspendieron y reanudaron conservando las mismas EC2 y el mismo disco de datos, y se eliminaron sin dejar recursos. Tiempos y detalle en [Motores IaC](docs/motores-iac.md#4-prueba-real-en-aws-desde-el-panel). Falta OpenTofu en AWS real.

### Pendiente

Diagrama (J1, con P1) y OpenTofu en AWS real. La comparación técnica (D6) y el documento de estado por motor (A6) están en [docs/motores-iac.md](docs/motores-iac.md).

### Qué defiendo en el video

1. `EngineAdapter`: el worker no depende del motor; agregar Pulumi o CloudFormation es implementar la misma interfaz.
2. Por qué hay un directorio y un estado por tenant, y cómo un reintento completa lo pendiente sin duplicar recursos.
3. Cómo se integra con el ejecutor y el servicio SSM de P6 (secretos fuera del IaC, logs filtrados) y cómo se registran las versiones de cada despliegue.

## P3 — Packer · cloud-init · Respaldos jorge

**Tareas del plan:** B1–B7 (todas completas) y la pantalla Respaldos.

### Qué hice

| Tarea | Resultado |
| --- | --- |
| **B1** Template Packer multi-source | `infra/packer/attendance.pkr.hcl`: una sola fuente Ubuntu 24.04 y **4 builds en paralelo** (frontend, backend, db, monitoring). Disco raíz cifrado, IMDSv2 obligatorio y tags `Role`, `ImageVersion`, `GitCommit`, `BackendRef`, `FrontendRef`. |
| **B2** Ansible dentro de Packer | `infra/ansible/image.yml` + roles `image_*`: Node 24 y build de `attendance-core`, nginx y build de `attendance-web`, PostgreSQL 16 detenido, Prometheus y Grafana en monitoring. En **todas**: node_exporter, process_exporter, OTel collector, Netdata, AWS CLI y `ansible-core`. |
| **B3** Automatización y manifiesto | `infra/packer/Makefile` (`packer-init/fmt/validate/build/ids`), `ami-manifest.json` y `scripts/ami_ids.py` → `ami-ids.json`, que consume el IaC. |
| **B4** cloud-init por rol | `infra/cloud-init/user-data.yaml.tftpl` + `attendance-boot.sh` + `infra/ansible/boot.yml` (roles `boot_*`). Escribe la identidad del tenant, lee los secretos de SSM, ejecuta Ansible en local, monta el EBS de datos de la BD sin reformatearlo y deja la señal `/var/lib/attendance/boot.json`. |
| **B5** Respaldo y restauración | `infra/backups/tenant-backup.sh` (`backup`, `restore`, `list`, `prune`) por SSM Run Command, sin SSH. `pg_dump` a S3 cifrado con prefijo por tenant, snapshot EBS etiquetado, retención por etiqueta y copia `pre-restore` automática antes de restaurar. Scripts en la VM: `attendance-backup` y `attendance-restore` (rol `image_db`). |
| **B6** Programador | Timer systemd en la VM db (semanal o diario según el plan) + políticas DLM para los snapshots programados (`infra/terraform/base/backups.tf`, revisado por P1). |
| **B7** IaC con AMIs ya construidas | El módulo tenant de P1 recibe los IDs de `ami-ids.json` y valida la etiqueta `Role`. Contrato en `docs/contratos-integracion.md`. |
| **Pantalla Respaldos** | `platform/platform_web/src/features/backups/`: listado, «Respaldar ahora», «Restaurar» con confirmación y progreso en vivo. En la API: operaciones `backup` y `restore` en la cola de P6 (migración `002_backups.sql`), handler del worker que ejecuta `tenant-backup.sh` y `GET /tenants/:id/backups`. |

### PRs

| PR | Contenido |
| --- | --- |
| [#4](https://github.com/Jalter-ego/attendance-platform/pull/4) | AMIs por rol con Packer + primer arranque con cloud-init y Ansible |
| [#5](https://github.com/Jalter-ego/attendance-platform/pull/5) | Respaldos de BD por tenant: pg_dump a S3, snapshots EBS, programación y restauración |
| [#7](https://github.com/Jalter-ego/attendance-platform/pull/7) | AMIs 0.2.1 con respaldos + corrección del arranque de la db |
| [#9](https://github.com/Jalter-ego/attendance-platform/pull/9) | AMIs 0.2.2: backend con límites del plan, métricas y demo de P4 |
| [#11](https://github.com/Jalter-ego/attendance-platform/pull/11) | Respaldos en la plataforma: operaciones `backup`/`restore` y pantalla |

### Cómo lo verifiqué

Con tenants desechables (`prueba-p3/test`) creados con el módulo de P1 y destruidos al terminar:

- **Arranque (B4):** los 3 roles quedan `ready`, health 200 en unos 90 s, login del admin inicial y datos conservados al reemplazar la VM db (el EBS no se reformatea).
- **AMIs 0.2.2:** límite del plan (`403`), `/metrics` 200 directo al puerto 5000 y 404 por nginx, `/demo/*` solo con `env=test`.
- **Respaldos (B5):** respaldo → borrar un usuario → restaurar → el usuario vuelve y puede iniciar sesión. También desde la plataforma, con cancelación y reintento.
- **Agente SSM** `Online` en frontend, backend y db (requisito de P1 para actualizar la app sin recrear VMs).
- Pruebas automáticas: `pnpm test:backups` en `platform/platform_api`.

Errores encontrados y corregidos en las pruebas reales: inventario de Ansible mal leído (0.1.1), migraciones sin entorno (0.1.2), variable `ansible_managed` en el arranque de la db (0.2.1), tildes y JSON partido por la salida de AWS CLI en Windows (PR #11).

### Qué defiendo en el video

1. `attendance.pkr.hcl`: multi-source, 4 AMIs en paralelo, Ansible como provisioner y tags de versión.
2. El recorrido del primer arranque: `user-data.yaml.tftpl` → `attendance-boot.sh` → `boot.yml` → `boot.json`.
3. `tenant-backup.sh` y la pantalla Respaldos: respaldar y restaurar en vivo.
4. Infraestructura inmutable: una versión nueva de la app es una AMI nueva (0.1.0 → 0.2.2), nunca cambios a mano en las VMs.

## P4 — Ansible · App del tenant · Planes (Marcelo, GitHub `MarceloCamachh`)

**Tareas del plan:** E1–E7, F1–F4, J2 y la pantalla Planes. Defiendo los roles y playbooks de Ansible, la adaptación de la app, los límites del plan (RF-05) y las pruebas de aislamiento.

### Qué hice

| Tarea | Resultado |
| --- | --- |
| **E3/E4/E5** App del tenant (`attendance-core`) | **Límites del plan:** `src/plan/` lee `PLAN_MAX_STUDENTS`, `PLAN_MAX_TEACHERS` y `PLAN_MAX_COURSES`, que escribe Ansible.<br>• Responde `403` con un mensaje claro al superarlos: *"Tu plan Básico permite hasta 100 estudiantes…"*.<br>• Estudiantes: se cuentan dentro de la transacción de la importación. Docentes: usuarios activos. Cursos: módulos en borrador o activos.<br>• Un valor inválido impide arrancar la API.<br>• `GET /plan/usage` muestra el uso frente a cada límite.<br>**Métricas:** `/metrics` con `prom-client` (latencia y peticiones por ruta, 5xx, event loop, heap). Oculto por nginx (404): Prometheus lo lee directo al puerto 5000.<br>**Demo:** `/demo/error` y `/demo/slow`, solo con `TENANT_ENV=test`.<br>El nombre de la institución, la zona horaria y el admin inicial ya venían por variables y se verificaron. |
| **E1** Roles Ansible | Los roles `boot_*` son de P3. Mi parte en ellos:<br>• `boot_backend` traduce `limits` a `PLAN_MAX_*`;<br>• desde el PR #17 espera `GET /core/api/v1/health` = 200 (la API **conectada a su base**) en lugar de 200/401/404 en la raíz. Entra con la próxima AMI.<br>README de `infra/ansible`. |
| **E2** Actualizar la app sin recrear las EC2 (RF-15) | **Playbook:** `infra/ansible/update.yml` con los roles `update_backend` y `update_frontend`. **Viaja dentro del paquete**, no en la AMI, así que funciona en las VMs ya creadas.<br>• Migra **antes** de cambiar nada.<br>• Cambia el enlace de forma atómica (`backend-current` o `/var/www/attendance`).<br>• Comprueba la salud y, **si falla, vuelve a la release anterior**.<br>• Conserva las 3 últimas releases.<br>**Scripts** en `infra/app-update/`:<br>• `build-release.sh` arma el paquete (código y `node_modules` compilados, `manifest.json`, `.sha256`), porque la VM no tiene Internet;<br>• `tenant-update.sh publish/apply/status` lo sube a S3 y lo instala por SSM Run Command;<br>• `remote-apply.sh` corre en la VM: candado, verificación del sha256 y Ansible.<br>Contrato con el worker: `docs/contrato-actualizacion.md`. |
| **E6** Health check de despliegue | `infra/health/tenant-health.sh`:<br>• comprueba `/healthz` y `/core/api/v1/health` a través del nginx público (nginx → API → PostgreSQL), con reintentos;<br>• con `--boot` lee el `boot.json` de las 3 VMs por SSM;<br>• devuelve JSON con un `reason` legible (502 API caída, 503 base caída). |
| **E7** Pruebas de aislamiento | `tests/isolation.sh` cubre las pruebas 1–5 del §9, cada una con un **control positivo**:<br>• SG entre backend y base;<br>• credenciales y `JWT_SECRET` distintos;<br>• el token de A da 401 en B;<br>• IAM: SSM solo con su prefijo, el frontend sin secretos y S3 de releases;<br>• un dato de A no aparece en B.<br>Ningún secreto viaja ni se muestra. `tests/isolation-sim/` lo reproduce con dos tenants en Docker. |
| **F1/F3** Modelo y semilla de planes | Migración `004_plans.sql`:<br>• agrega respaldo, descripción y **versión** a `plans`;<br>• restricciones `CHECK` con las mismas reglas que el módulo de P1;<br>• `tenants.plan_snapshot`, una **copia del plan** que llena un trigger al registrar el tenant.<br>Los motores despliegan esa copia (`tenant-input.js` y `deployment-config.js`). |
| **F2** API de planes (RF-04) | `platform_api/src/modules/plans/`: `GET/POST /plans` y `GET/PUT/DELETE /plans/:code`, con validación zod y mensajes por campo.<br>• Editar crea una versión nueva y **no toca los tenants existentes**, porque cambiar sus límites recrearía sus EC2 (`user_data_replace_on_change`).<br>• `409` si otro editó antes, o si el plan está en uso al eliminarlo. |
| **F4** Pantalla **Planes** | `platform_web/src/features/plans/`:<br>• tarjetas con límites, servidores, disco y respaldo, versión y uso ("2 en versión anterior");<br>• editor con validación en vivo y aviso de qué instituciones **no** cambian, con confirmación obligatoria;<br>• crear y eliminar.<br>El wizard de P2 muestra los planes nuevos. |
| **J2** Catálogo | `docs/catalogo-planes.md`: catálogo, qué cuenta cada límite en la app, recorrido catálogo → VM, reglas y política de versiones. `limits` y `backup` en `docs/examples/tenant.example.json`. |
| **J4** Manual (mi sección) | `docs/manual/p4-planes-actualizacion.md`: planes (crear, editar con versiones, aplicar la versión nueva, eliminar), límites que ve la institución, actualizar la app desde **Actualizar**, salud y aislamiento, y problemas frecuentes. |

### PRs

| Repo | PR | Contenido |
| --- | --- | --- |
| attendance-core | [#6](https://github.com/Jalter-ego/attendance-core/pull/6) | Límites del plan, `/plan/usage`, `/metrics`, endpoints demo, 57 pruebas y colección Postman |
| attendance-platform | [#14](https://github.com/Jalter-ego/attendance-platform/pull/14) | `update.yml` y roles `update_*` (E2) con pruebas en Docker |
| | [#15](https://github.com/Jalter-ego/attendance-platform/pull/15) | `build-release.sh`, `tenant-update.sh`, `remote-apply.sh`, `tenant-health.sh` y prueba de punta a punta |
| | [#17](https://github.com/Jalter-ego/attendance-platform/pull/17) | `boot_backend` espera `/health`; README de `infra/ansible` |
| | [#22](https://github.com/Jalter-ego/attendance-platform/pull/22) · [#23](https://github.com/Jalter-ego/attendance-platform/pull/23) | Migración 004 y API de planes (#23 corrige el `package.json` roto por el merge) |
| | [#24](https://github.com/Jalter-ego/attendance-platform/pull/24) | Pantalla Planes |
| | [#25](https://github.com/Jalter-ego/attendance-platform/pull/25) | Arreglos para Windows encontrados por P3 en AWS: `AWS_CLI_OUTPUT_ENCODING` y `boot.json` en varias líneas |
| | [#26](https://github.com/Jalter-ego/attendance-platform/pull/26) | Catálogo de planes (J2) y `tenant.example.json` |
| | [#28](https://github.com/Jalter-ego/attendance-platform/pull/28) | `tests/isolation.sh`, simulación en Docker y sección Planes del README |

### Cómo lo verifiqué

- **App:** 57 pruebas unitarias (`pnpm test` en `attendance-core`) y un recorrido contra un PostgreSQL real:
  - los `403` de docentes, cursos y estudiantes, incluido contar en otros módulos;
  - modo sin límites, `/plan/usage`, `/metrics` y `/demo/*` en `test` y en `prod`.
- **Actualización y salud, en Docker** (`infra/ansible/tests/update/`): `run.sh` 10/10 y `e2e.sh` 22/22.
  - Usan los paquetes **reales** de core y web, PostgreSQL y migraciones reales.
  - Cubren la vuelta atrás, la misma VM y los mismos datos, y los casos de API o base caída.
  - La AWS CLI se simula y responde con `\r\n`, como la de Windows del worker.
- **En AWS, por P3** con `prueba-p3/test`:
  - backend `ecf3f46d0e9f` → `6ac1f4697347` con la **misma EC2** (`i-0409175e2fc14e60d`) y los datos intactos;
  - un paquete roto quedó en `rolled_back` y la app siguió sana;
  - `tenant-health.sh` respondió `healthy` en 49 s, con las 3 VMs `ready`.
- **Planes:** 8 pruebas de API contra PostgreSQL real (`pnpm test:plans`), incluida "**editar un plan no cambia la entrada del motor de un tenant existente**". La suite completa del API pasa (71). La pantalla se recorrió en Chrome: edición a v3 con aviso, validación y creación.
- **Aislamiento:** `tests/isolation-sim/run.sh` 7/7 con dos tenants en redes Docker separadas.
  - Con los tenants aislados pasan las 20 comprobaciones.
  - Con una **fuga provocada** (red abierta y `JWT_SECRET` repetido), el script la **detecta**.
  - Ningún secreto aparece en la salida.
- `shellcheck` sin avisos en todos los scripts, `ansible-playbook --syntax-check`, y `pnpm lint` y `pnpm build` del frontend.

Errores encontrados y corregidos:
- `/demo/slow?ms=abc` esperaba en vez de responder 400, porque el `ValidationPipe` global convertía el texto en `NaN`.
- Las rutas 404 quedaban etiquetadas como `*path` en las métricas.
- Un `CHECK` de PostgreSQL dejaba pasar claves ausentes, porque acepta `NULL`.
- Editar un plan habría recreado las EC2 de sus tenants en el siguiente suspend o resume. Lo resolví con la copia del plan.
- El merge del PR #22 rompió `package.json`.
- La AWS CLI de Windows perdía el JSON por la codificación, y `boot.json` estaba en varias líneas (los encontró P3 en AWS).

### Pendiente

- Correr `tests/isolation.sh` en AWS con dos tenants y guardar el log como evidencia de J5.
- Que P3 incluya en la próxima AMI (0.2.3) el cambio de `boot_backend`, con `--exclude=tests/`.

### Qué defiendo en el video

1. **Ansible en dos momentos:**
   - `boot_backend` configura la app con los secretos y los `PLAN_MAX_*` de su tenant;
   - `update.yml` actualiza sin recrear la VM: migra, cambia el enlace de forma atómica, comprueba la salud y vuelve atrás si falla.

   Es complementario a la AMI inmutable de P3: la AMI cambia el sistema; el paquete versionado cambia la app con trazabilidad y vuelta atrás.
2. **Límites del plan (RF-05):** cómo cuenta la app estudiantes, docentes y cursos, y el `403` en vivo con `/plan/usage`.
3. **Planes con versiones (RF-04):** por qué editar un plan no toca los tenants existentes (la copia del plan evita recrear sus EC2), y la pantalla Planes.
4. **Aislamiento:** las 5 pruebas con su control positivo, la fuga provocada que el script detecta y la segunda barrera del core (el token se valida contra **su** base).

## P5 — _por completar_

## P6 — Sebastián: plataforma local y aprovisionamiento integrado

**Tareas del plan:** H1–H11, J4 y sección individual J8. Integra los módulos del equipo; no atribuye a P6 la autoría original de la red, los motores de P2, las AMIs, los respaldos, la app ni el monitoreo.

### Qué integro y defiendo

- Registro y encolado atómicos, permisos de plataforma/tenant, consultas e historial.
- Worker separado, reclamación transaccional con `SKIP LOCKED`, una operación activa por tenant, heartbeat, cancelación y recuperación de trabajos interrumpidos.
- Ejecutor compartido de comandos con timeout, filtrado de secretos y eventos consultables desde el panel.
- Configuración congelada por despliegue y reintento vinculado al intento anterior para conservar identidad, AMIs y estado.
- Ciclo de vida conectado a los componentes del equipo, vistas previas y auditoría de actor, fecha y resultado.
- Integración con el programa/adaptador Pulumi de P2 que crea tres EC2, conserva su estado en S3 y permite suspender/reanudar sin borrar el EBS de PostgreSQL.
- Arranque reproducible del panel/API/worker en Windows con PostgreSQL dedicado y credenciales locales fuera de Git.

### Archivos principales

`platform/platform_api/src/modules/operations/operations.service.js`, `src/modules/deployments/deployment-config.js`, `src/worker/queue.js`, `src/worker/handlers/create.handler.js`, `src/worker/services/command-runner.js`, `src/lib/redact.js`, `src/modules/audit/audit.service.js`, `src/engines/pulumi.js`, `src/worker/services/pulumi-lifecycle.js` e `infra/pulumi/tenant/`.

Manual y arranque: `platform/DEMO-P6.md`, `platform/LOCAL.md` y `platform/scripts/start-local.ps1`. El manual conserva como base las secciones de los responsables del equipo.

### PR y verificación

- [PR #27](https://github.com/Jalter-ego/attendance-platform/pull/27): integración anterior de P6 con PR #26, fusionada en master.
- En la ampliación local: suite API sin AWS, integración con PostgreSQL dedicado y dobles, lint/build del panel, SDK Pulumi con mocks y CLI Pulumi real con backend local y un componente sin recursos AWS.
- Prueba AWS voluntaria: `platform/platform_api/tests/aws.e2e.js`, que registra operaciones, comprueba salud y conserva un marcador PostgreSQL durante suspensión/reanudación. Los resultados reales se guardan en `.local/aws-evidence/`; una prueba local con dobles no se presenta como una validación AWS.

### Qué muestro en el video

Crear desde el asistente con el motor elegido, seguir el trabajo en el detalle, mostrar inventario/URLs/versiones, explicar el reintento sobre el mismo estado y enseñar la auditoría. En código, centrar la defensa en la transacción de registro, la cola y el ejecutor, en coordinación con los responsables de los otros módulos.
