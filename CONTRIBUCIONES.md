# Contribuciones

Quién hizo qué en Tenant Control Center, como apoyo para la defensa individual (tarea J8 del
[plan](docs/Plan_de_implementacion_Tenant_Control_Center.md#4-reparto-del-equipo-6-personas)).
Cada integrante completa **su propia sección**: tareas, archivos que defiende, PRs y cómo lo verificó.
Los commits y PRs llevan el autor real.

| Rol | Integrante | Eje (herramienta de la materia) | Pantallas | Suplente |
| --- | --- | --- | --- | --- |
| P1 | _por completar_ | Terraform base y módulo tenant | _por completar_ | P2 |
| P2 | _por completar_ | Motores IaC (Tofu, Pulumi, CloudFormation) | _por completar_ | P1 |
| P3 | jorge (GitHub `Gatu-1548`) | **Packer · cloud-init · Respaldos** | Respaldos | P4 |
| P4 | _por completar_ | Ansible · app del tenant · planes | _por completar_ | P3 |
| P5 | _por completar_ | Observabilidad · escáneres de seguridad | Inicio, Monitoreo, Seguridad | P6 |
| P6 | _por completar_ | Plataforma: API · worker · auditoría | _por completar_ | P5 |

---

## P1 — _por completar_

## P2 — _por completar_

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
