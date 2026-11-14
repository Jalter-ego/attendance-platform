# Contribuciones

Quién hizo qué en Tenant Control Center, como apoyo para la defensa individual (tarea J8 del
[plan](docs/Plan_de_implementacion_Tenant_Control_Center.md#4-reparto-del-equipo-6-personas)).
Cada integrante completa **su propia sección**: tareas, archivos que defiende, PRs y cómo lo verificó.
Los commits y PRs llevan el autor real.

| Rol | Integrante | Eje (herramienta de la materia) | Pantallas | Suplente |
| --- | --- | --- | --- | --- |
| P1 | _por completar_ | Terraform base y módulo tenant | _por completar_ | P2 |
| P2 | GitHub `Arlin-Ab` | **Motores IaC: EngineAdapter, Terraform/OpenTofu, Pulumi, CloudFormation** | Crear tenant (wizard), panel Infraestructura | P1 |
| P3 | jorge (GitHub `Gatu-1548`) | **Packer · cloud-init · Respaldos** | Respaldos | P4 |
| P4 | _por completar_ | Ansible · app del tenant · planes | _por completar_ | P3 |
| P5 | _por completar_ | Observabilidad · escáneres de seguridad | Inicio, Monitoreo, Seguridad | P6 |
| P6 | _por completar_ | Plataforma: API · worker · auditoría | _por completar_ | P5 |

---

## P1 — _por completar_

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

Pendiente de probar en AWS: el ciclo integrado del panel con Terraform y OpenTofu y los adaptadores de CloudFormation y Pulumi de P2. En la integración con P6, el asistente registra CloudFormation como borrador y en local permite simularlo. El adaptador y la plantilla se documentan en [CloudFormation](infra/cloudformation/README.md).

### Pendiente

Comparación técnica (D6), documento de estado por motor (A6) y diagrama (J1). El estado de CloudFormation y de Pulumi ya está descrito en sus README.

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

## P4 — _por completar_

## P5 — _por completar_

## P6 — _por completar_
