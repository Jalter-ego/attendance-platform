# Plan de implementación — Plataforma de Tenants (Tenant Control Center)

> Proyecto final · equipo de 6 personas · AWS como nube principal

---

## 0. Resumen y supuestos

**Qué se construye:** una plataforma local (React + API + worker) que permite elegir un plan, crear un *tenant* (una institución) y aprovisionar en AWS **3 servidores EC2 por tenant (frontend, backend, base de datos)** usando Packer → Terraform/OpenTofu (o Pulumi / CloudFormation) → cloud-init → Ansible. Cada tenant queda monitoreado en Grafana y se gestiona durante todo su ciclo de vida (actualizar, suspender, reanudar, cambiar de plan, respaldar, restaurar, eliminar).

1. **Cloud:** solo AWS. El docente confirmó que alcanza con AWS (Azure es opcional, no lo planificamos).
2. **Fecha de entrega:** el docente dijo que el siguiente módulo arranca el lunes y que "el domingo ya deberían estar con esto". Hoy es jueves 12-nov-2026, así que el plan asume **entrega el domingo 15-nov** (≈3,5 días). Si la fecha real es posterior, se alarga la Fase 2 y no cambia el reparto. **Confirmar la fecha con el docente hoy.**
3. **App de asistencia (RF-21):** ya existe, con login y 3 roles (administrador de la app, docente, estudiante). Solo se adapta (config por tenant, límites del plan, métricas). No se rediseña.
4. **La plataforma corre en local** (no hace falta publicarla), pero **crea infraestructura real en AWS**.
5. **Motores IaC:** Terraform es el principal; OpenTofu reutiliza los mismos módulos; Pulumi y CloudFormation son implementaciones más pequeñas + comparación técnica, **pero deben aparecer en el selector del wizard** (así lo mostró el docente).
6. El stack del demo del docente fue React + Node. Las tareas están redactadas de forma neutral; usen el stack que ya tengan.

**Prioridades usadas en las tablas:** **M** = obligatorio (criterios de aceptación) · **S** = recomendable · **C** = si sobra tiempo.

---

## 1. Pautas del docente y cómo las cubre este plan

| Pauta dada en clase | Cómo se cubre |
|---|---|
| Nadie debe hacer solo frontend; la UI en React "no tiene mérito" porque no es de la materia | Cada persona es dueña de **una herramienta de la materia + una parte de backend/automatización**, y construye solo **su(s) pantalla(s)**. La UI es ≤ ~20 % de la carga de cada uno (§4). |
| En el video **cada uno defiende lo que hizo** (en código) | Cada persona tiene un "paquete de código a defender" y un minuto asignado en el guion (§10). Commits y PRs por autor + `CONTRIBUCIONES.md`. |
| Hay que usar **todas las herramientas, en todos los tenants** (Packer incluido) | Toda creación de tenant pasa por AMIs de Packer → motor IaC → cloud-init → Ansible → exporters/Grafana. |
| Orden real: **Packer primero**, luego Terraform, cloud-init y Ansible | Ruta crítica del cronograma: las AMIs se lanzan la primera noche (§6). |
| Cada tenant = **3 instancias EC2** (front, back, BD), **todas visibles en Grafana** | Módulo IaC `tenant` con 3 EC2 + etiquetas; Prometheus las descubre por tags. |
| **Base de datos separada por tenant** (nada de datos cruzados) | BD en EC2 propia, credenciales y SG propios, pruebas de aislamiento (§9). |
| Prometheus + Grafana **en un servidor aparte** (no en el servidor del tenant); exporters en cada servidor; Grafana solo habla con Prometheus | Servidor de monitoreo en la capa base; exporters horneados en las AMIs. |
| **Mínimo 3 escáneres de seguridad**, con resultados **visibles en la plataforma** (no hace falta corregir los hallazgos) | Tarea G6 + pestaña "Seguridad" por tenant. |
| Pantallas mínimas: login, Inicio, Tenants (activos/pausados), Planes, Monitoreo (botón a Grafana), Auditoría, Crear tenant (wizard con selector de motor) | Reparto de pantallas en §4. |
| Todo **como código** (sin clics en consolas; hasta los dashboards de Grafana) | Dashboards y datasource provisionados por archivos; nada manual en AWS. |
| Dashboard de ejemplo: errores 500, latencia por ruta, peticiones/s, event loop, heap, CPU, memoria | Tarea G3. |
| Alertas tipo "CPU > 50-60 %" con notificación (correo, Telegram, etc.) | Tarea G4/G5. |
| Video **máx. 15 min por grupo**, solo pantalla + código (sin cámara); **solo el líder** sube el documento con nombres, nombre del equipo y link del video | §10. |
| Documentación: código, **diagrama de arquitectura (EC2/VPC)**, manual de usuario simple pero entendible | §3-J. |
| Con que corra **localmente** está bien | Supuesto 4. |
| Una sola cuenta/cloud con tamaños distintos por plan es suficiente | Catálogo de planes (§8). |
| El proyecto pesa ≈ 50 % de la nota | Se prioriza cumplir todos los criterios de aceptación antes que adornos. |

---

## 2. Arquitectura objetivo

```
┌──────────────── Máquina local del equipo ────────────────┐
│  Web (React) ─► API ─► Cola de trabajos ─► Worker        │      BD de la plataforma
│                                              │ ejecuta   │      (tenants, planes, operaciones,
│                                              ▼ CLIs      │       auditoría, alertas, escaneos)
│        terraform | tofu | pulumi | aws cloudformation    │
└──────────────────────────────┬───────────────────────────┘
                               ▼
┌───────────────────────────── AWS ───────────────────────────────────────────────┐
│  CAPA BASE (una vez): VPC · subredes · S3 (estado) · SSM (secretos) · AMIs      │
│  Servidor de MONITOREO: Prometheus (9090) + Grafana (3000)                      │
│        ▲  scrape 9100 / 9256 / 8889 / 19999 / backend:/metrics (descubre por tags)
│        │                                                                        │
│  TENANT "san-marcos" / prod            TENANT "otra-uni" / prod …               │
│   EC2 Frontend ─► EC2 Backend ─► EC2 BD   (SG propios, BD y credenciales propias)│
│   (AMI Packer)   (AMI Packer)   (AMI Packer + disco EBS)                        │
│   cada EC2: node_exporter · process_exporter · OTel collector · Netdata         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Flujo de creación de un tenant

1. **Wizard** (Datos y plan → Configuración → Revisión) → `POST /tenants`.
2. La API valida (id único, plan, motor), guarda el tenant en estado `pending`, escribe auditoría y encola la operación `create`.
3. El **worker** toma el trabajo (1 trabajo activo por tenant) y ejecuta los **escáneres de IaC** (resultados guardados).
4. Genera los secretos (contraseña de BD, etc.) y los guarda en **SSM Parameter Store** bajo `/tenants/<id>/<env>/`.
5. El **adaptador del motor elegido** corre `apply/up/deploy` con el estado propio del tenant. Crea: SG, 3 EC2 (desde las AMIs de Packer), EBS, perfil IAM, etiquetas.
6. En el primer arranque **cloud-init** escribe las variables del tenant (leyendo SSM) y lanza **Ansible en modo local**.
7. **Ansible** configura: BD (esquema, usuario, solo accesible desde el backend) → backend (conexión a BD, límites del plan, servicio) → frontend (URL del API).
8. El worker hace **health checks** (frontend 200, backend `/health`, conexión a BD) y guarda URLs, IDs de recursos y **versiones usadas** (app, AMIs, plantillas, herramientas).
9. **Prometheus descubre** las 3 EC2 por etiquetas (`Tenant`, `Env`, `Role`) → aparecen en Grafana sin pasos manuales.
10. El tenant pasa a `active`; la UI muestra progreso, logs sin secretos y el resultado final.

### Función de cada herramienta (entregable: "explicar qué hace cada una")

| Herramienta | Función en nuestra arquitectura |
|---|---|
| **Packer** | Construye (antes de todo) las AMIs de frontend, backend, BD y monitoreo con runtime y exporters ya instalados. |
| **Terraform / OpenTofu** | Motor principal: crea SG, 3 EC2, discos, IAM y etiquetas por tenant; también `plan` para las vistas previas. |
| **Pulumi / CloudFormation** | Segunda implementación del mismo stack + comparación técnica; seleccionables en el wizard. |
| **cloud-init** | Primer arranque de cada VM: escribe variables del tenant y dispara Ansible. |
| **Ansible** | Configura BD, backend, frontend y agentes de observabilidad; también actualiza la app. |
| **Prometheus + exporters** | Recolecta métricas (SO, procesos, backend, OTel, Netdata). |
| **Grafana** | Paneles y alertas por tenant/entorno; único consumidor de Prometheus. |
| **Escáneres (≥3)** | Revisan IaC, imágenes/dependencias y secretos; los hallazgos se registran en la plataforma. |

---

## 3. Lista completa de trabajo (qué hace falta)

### A. Fundación, estado y secretos
| ID | Tarea | RF/RNF | Prio | Dueño |
|---|---|---|---|---|
| A1 | Monorepo (`platform/`, `infra/{terraform,pulumi,cloudformation,packer,ansible,cloud-init}`, `observability/`, `docs/`, `tests/`), ramas + PR por módulo, `.gitignore`, hook gitleaks | RNF | M | P1 |
| A2 | AWS: acceso por persona (mínimo privilegio), región, **verificar cuota de vCPU** (cada t3 = 2 vCPU), presupuesto/alerta de costos | RNF | M | P1 |
| A3 | Backend de estado: bucket S3 cifrado, versionado, acceso restringido y bloqueo; una clave por tenant+entorno (`tenants/<id>/<env>/…`) | RNF | M | P1 |
| A4 | Secretos en SSM Parameter Store (SecureString); el perfil IAM de cada instancia solo lee **su** prefijo; nada en repo, estado ni logs (los secretos se generan fuera del IaC y el IaC solo referencia el nombre) | RNF | M | P1 |
| A5 | **Capa base**: VPC, subredes, rutas, SG base, rol para Prometheus (`ec2:DescribeInstances`), servidor de monitoreo | RF-09 | M | P1 |
| A6 | Documento "cómo se almacena y protege el estado" para cada motor (Terraform/OpenTofu en S3; Pulumi en S3 + secrets provider; CloudFormation en AWS) | RNF | M | P1 + P2 |
| A7 | Script de control de costos: detener/destruir recursos con `Env=test` | RNF | M | P1 |

### B. Imágenes, bootstrap y respaldos
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| B1 | Template **Packer** con 3 AMIs de rol (front, back, BD) + AMI de monitoreo; `source` múltiples para construir en paralelo; tags de versión/commit | RF-09, RF-13 | M | P3 |
| B2 | Provisioner Ansible dentro de Packer: runtime, nginx, motor de BD, node_exporter, process_exporter, OTel collector, Netdata | RF-09 | M | P3 |
| B3 | `make packer-*` (`init/fmt/validate/build`) y `ami-manifest.json` con los IDs consumidos por el IaC | RF-13 | M | P3 |
| B4 | Plantillas **cloud-init** por rol: leer SSM, escribir variables, ejecutar Ansible local, señal de "listo" | RF-10 | M | P3 |
| B5 | **Respaldo/restauración**: dump de BD → S3 cifrado (prefijo por tenant) + snapshot EBS etiquetado; restore reproducible; retención según plan | RF-19 | M | P3 |
| B6 | Programador de respaldos (semanal / diario) según plan | RF-19 | S | P3 |
| B7 | Estrategia para que el IaC use AMIs ya construidas (variable/`data source` por tag) | RF-09 | M | P3 + P1 |

### C. Terraform / OpenTofu
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| C1 | Módulo `tenant`: SG por rol, 3 EC2 desde AMIs, EBS, perfil IAM, etiquetas (`Tenant`, `Env`, `Role`, `Plan`) | RF-09 | M | P1 |
| C2 | Variables derivadas del plan (tamaños, disco) y outputs (URLs, IDs, IPs privadas) | RF-02, RF-07 | M | P1 |
| C3 | Suspender/reanudar: variable `suspended` + `aws_ec2_instance_state` (para instancias, conserva EBS) | RF-16, RF-17 | M | P1 |
| C4 | Vista previa con `plan` → `show -json` → lista legible (para cambio de plan y para eliminar) | RF-06, RF-18 | M | P1 |
| C5 | Cambio de plan (resize de instancia/disco) con aviso de downtime | RF-06 | M | P1 |
| C6 | Compatibilidad **OpenTofu** (`tofu`) con los mismos módulos | RF-08 | M | P1 |
| C7 | Idempotencia: estado por tenant, bloqueo, `apply` repetible, qué hacer con recursos a medias tras un fallo | RF-12 | M | P1 |

### D. Pulumi, CloudFormation y adaptador de motores
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| D1 | Interfaz `EngineAdapter` (`preview`, `apply`, `destroy`, `outputs`, `suspend`, `resume`, `versions`) + resultado estándar | RF-08 | M | P2 |
| D2 | Adaptadores Terraform y OpenTofu (invocan el CLI con vars y estado del tenant) | RF-08 | M | P2 (con P1) |
| D3 | Programa **Pulumi** del mismo stack + backend S3 + `pulumi preview` | RF-08 | M (al menos plan Básico) | P2 |
| D4 | Plantilla **CloudFormation** (parámetros por plan, *change sets* para vista previa, un stack por tenant) | RF-08 | M (al menos plan Básico) | P2 |
| D5 | Limitación a documentar: CloudFormation no detiene instancias de forma declarativa → suspensión vía API de EC2 desde el worker | RF-16 | S | P2 |
| D6 | **Comparación técnica** de los 4 motores (estado, preview, idempotencia, rollback, curva de aprendizaje) | Sección 4 | M | P2 |
| D7 | **Registro de versiones** por despliegue: versión de la app, AMIs, commit de plantillas, versiones de terraform/tofu/pulumi/packer/ansible | RF-13 | M | P2 |

### E. App del tenant y Ansible
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| E1 | Roles Ansible `db`, `backend`, `frontend` (BD/usuario, conexión backend→BD por IP privada, servicio, nginx con URL del API) | RF-09, RF-10 | M | P4 |
| E2 | Playbook de **actualización** de la app (versionado, sin recrear infraestructura) | RF-15 | M | P4 |
| E3 | Adaptar la app existente: nombre de institución, zona horaria, admin inicial del tenant por variables | RF-21 | M | P4 |
| E4 | **Límites del plan en la app** (máx. estudiantes/docentes/cursos/almacenamiento) con mensaje claro al excederlos | RF-05 | M | P4 |
| E5 | Backend expone `/health` y `/metrics` (latencia por ruta, 5xx, peticiones, event loop/heap si es Node); endpoints de demo `/api/error` y `/api/slow` solo fuera de producción | RF-26 | M | P4 (con P5) |
| E6 | Health check del despliegue (front 200, back `/health`, BD conectada) consumido por el worker | RF-11 | M | P4 |
| E7 | Pruebas de aislamiento a nivel app/BD (tokens, credenciales, datos) | Aceptación | M | P4 |

### F. Catálogo de planes
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| F1 | Modelo de plan: cómputo, disco, BD, límites de uso, frecuencia de respaldo, retención | RF-02 | M | P4 |
| F2 | API CRUD de planes + validación (editar un plan no rompe tenants existentes sin aviso) | RF-04 | M | P4 |
| F3 | Semilla Básico / Estándar / Avanzado | RF-01 | M | P4 |
| F4 | Pantalla **Planes** | RF-01, RF-04 | M | P4 |

### G. Observabilidad y seguridad
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| G1 | Prometheus con `ec2_sd_configs` por etiquetas → labels `tenant`, `env`, `role`; scrape de 9100, 9256, 8889, 19999 y `/metrics` del backend | RF-27 | M | P5 |
| G2 | Grafana **provisionado por código**: datasource Prometheus, dashboards JSON, variables `tenant` y `env` | RF-25, RF-27 | M | P5 |
| G3 | Paneles mínimos: disponibilidad, CPU, memoria, latencia, errores del backend, estado de BD, disco (+ peticiones/s, event loop, heap) | RF-26 | M | P5 |
| G4 | Alertas: servicio caído (`up == 0`), % de errores 5xx, CPU/memoria/disco sobre umbral | RF-28 | M | P5 |
| G5 | Canal de alertas: *webhook* → API de la plataforma (tenant, severidad, hora de detección) + opcional Telegram/correo | RF-29 | M | P5 |
| G6 | **≥3 escáneres** en el flujo (p. ej. Checkov o tfsec para IaC, Trivy para AMI/dependencias, Gitleaks para secretos; opcional ansible-lint) → JSON → API → pestaña Seguridad | Pauta docente | M | P5 |
| G7 | **Netdata** y **OpenTelemetry collector** corriendo y visibles (un panel o enlace por cada uno) | Pauta docente | M | P5 |
| G8 | Pantallas **Inicio**, **Monitoreo** (estado por tenant, botón a Grafana, alertas recientes) y pestaña **Seguridad** | RF-29 | M | P5 |
| G9 | Evidencia de **alerta de ejemplo** (forzar 500s o detener un servicio) | Aceptación | M | P5 |

### H. Plataforma (API, worker, auditoría)
| ID | Tarea | RF | Prio | Dueño |
|---|---|---|---|---|
| H1 | Modelo de datos: tenants, plans, operations, operation_events, deployments (versiones), audit_log, alerts, scan_results, users | RF-13, RF-20 | M | P6 |
| H2 | API REST (ver contrato §7) + autenticación: admin de plataforma (gestiona todo) y admin de tenant (solo ve su estado) | Usuarios | M | P6 |
| H3 | Cola de trabajos + worker en proceso aparte; 1 trabajo activo por tenant (lock); estados y progreso por etapas | RNF | M | P6 |
| H4 | Ejecutor de CLIs con logs en streaming, timeout y cancelación | RF-11 | M | P6 |
| H5 | **Redacción de secretos** en logs y traducción de errores técnicos a mensajes comprensibles | RF-11, RNF | M | P6 |
| H6 | Reintento de operación fallida sin duplicar recursos (usa C7/D1) | RF-12 | M | P6 + P1 |
| H7 | **Auditoría**: quién inició, cuándo, resultado | RF-20 | M | P6 |
| H8 | Operaciones del ciclo de vida: crear, actualizar app/infra, suspender, reanudar, cambiar plan, respaldar, restaurar, eliminar con confirmación | RF-14…19 | M | P6 |
| H9 | Consulta de tenants por nombre, estado, plan y entorno | RF-14 | M | P6 |
| H10 | Pantallas **Login**, menú/shell, **Tenants** (lista + detalle con operaciones, URLs, versiones, logs) | RF-11, RF-14 | M | P6 |
| H11 | Script de demo / pruebas e2e (crear → verificar → suspender → reanudar → eliminar) | Aceptación | S | P6 |

### I. Pantallas distribuidas (para que nadie sea "solo frontend")
| Pantalla | Dueño |
|---|---|
| Wizard Crear tenant (3 pasos, selector de motor, revisión con recursos) + vista previa de cambio de plan | P2 |
| Modales de suspender/reanudar y **eliminar con confirmación y lista de recursos/datos** + pantalla **Auditoría** | P1 |
| Pantalla **Respaldos** (listar, crear, restaurar) | P3 |
| Pantalla **Planes** | P4 |
| **Inicio**, **Monitoreo**, pestaña **Seguridad** | P5 |
| **Login**, shell, **Tenants** lista/detalle, progreso y logs | P6 |

### J. Calidad, documentación y entrega
| ID | Entregable | Dueño |
|---|---|---|
| J1 | Diagrama de arquitectura (VPC, SG, EC2, S3, SSM, monitoreo) y flujo de creación de tenant | P1 + P2 |
| J2 | Catálogo de planes y límites (documento) | P4 |
| J3 | Tablero Grafana (JSON + capturas) con alerta de ejemplo | P5 |
| J4 | Manual de usuario: crear, actualizar, suspender, reanudar, respaldar, restaurar, eliminar (cada dueño escribe su sección; **P6 compila**) | todos / P6 |
| J5 | Evidencia de aislamiento entre tenants (comandos, capturas, script `tests/isolation.sh`) | P4 + P1 + P5 |
| J6 | Guion y grabación del video (≤ 15 min) | P1 coordina |
| J7 | Documento final: nombres, nombre del equipo, link del video (**lo sube solo el líder**) | P1 |
| J8 | `CONTRIBUCIONES.md`: quién hizo qué (apoyo para la defensa individual) | todos |

---

## 4. Reparto del equipo (6 personas)

**Reglas del reparto**

- Cada persona tiene **1 herramienta de la materia como eje** + **1 parte de plataforma/app** + **su(s) pantalla(s)**. Nadie hace solo frontend ni solo documentación.
- Cada eje tiene un **suplente** (pares P1↔P2, P3↔P4, P5↔P6) para no depender de una sola persona y para que cualquiera pueda explicar el flujo completo.
- Todos deben poder explicar el flujo de punta a punta; además cada uno **defiende su código** en el video.
- Trabajo por ramas y PR; **commits con el autor real** (el docente pidió explicar quién hizo qué).

### P1 — Líder técnico · Terraform/OpenTofu · Estado y secretos
- **Tareas:** A1–A7, C1–C7, B7 (con P3), J1 (con P2), J6, J7.
- **Pantallas:** modales suspender/reanudar/eliminar + Auditoría.
- **Defiende en el video:** módulo Terraform del tenant, backend de estado en S3, SSM/IAM, capa base, OpenTofu.
- **Además:** coordina integración, resuelve bloqueos, sube el documento final. **Suplente:** P2.

### P2 — Motores alternativos · Adaptador multi-motor · Wizard
- **Tareas:** D1–D7, A6 (con P1), J1 (con P1).
- **Pantallas:** wizard Crear tenant + vista previa de cambio de plan.
- **Defiende:** `EngineAdapter`, Pulumi, CloudFormation, comparación técnica, registro de versiones.
- **Suplente:** P1.

### P3 — Packer · cloud-init · Respaldos
- **Tareas:** B1–B7.
- **Pantallas:** Respaldos.
- **Defiende:** templates Packer (multi-source), AMIs, cloud-init, scripts de backup/restore.
- **Suplente:** P4.

### P4 — Ansible · App del tenant · Planes
- **Tareas:** E1–E7, F1–F4, J2.
- **Pantallas:** Planes.
- **Defiende:** roles/playbooks Ansible, adaptación de la app, límites del plan (RF-05), pruebas de aislamiento de la app.
- **Suplente:** P3.

### P5 — Observabilidad · Escáneres de seguridad
- **Tareas:** G1–G9, J3.
- **Pantallas:** Inicio, Monitoreo, Seguridad.
- **Defiende:** Prometheus (ec2_sd), exporters, OTel, Netdata, dashboards-as-code, alertas, escáneres.
- **Suplente:** P6.

### P6 — Plataforma: API · worker · auditoría
- **Tareas:** H1–H11, J4.
- **Pantallas:** Login, shell, Tenants (lista/detalle/logs).
- **Defiende:** cola + worker, ejecución de CLIs, redacción de secretos, reintentos, auditoría.
- **Suplente:** P5.

**Balance aproximado de carga**

| | Infra/IaC | Automatización/config | Backend | UI |
|---|---|---|---|---|
| P1 | ██████ | ██ | █ | █ |
| P2 | █████ | █ | ███ | ██ |
| P3 | ███ | █████ | ██ | █ |
| P4 | █ | ████ | ████ | █ |
| P5 | ██ | ████ | ██ | ██ |
| P6 | █ | █ | ██████ | ██ |

---

## 5. Cobertura de requisitos funcionales

| RF | Responsables (tareas) |
|---|---|
| RF-01, 02, 04 | P4 (F1–F4) |
| RF-03 | P2 (wizard) |
| RF-05 | P4 (E4) + P6 (validación al crear) |
| RF-06 | P1 (C4, C5) + P2 (vista previa UI) |
| RF-07 | P6 (H8) + P2 (wizard) |
| RF-08 | P2 (D1–D4) + P1 (C6) |
| RF-09 | P1 (C1) + P3 (B1–B2) + P4 (E1) |
| RF-10 | P3 (B4) + P4 (E1, E6) |
| RF-11 | P6 (H3–H5) + P4 (E6) |
| RF-12 | P1 (C7) + P6 (H6) |
| RF-13 | P2 (D7) + P3 (B3) |
| RF-14 | P6 (H9) |
| RF-15 | P4 (E2) + P1 (infra) + P6 (H8) |
| RF-16, 17 | P1 (C3) + P2 (D5) |
| RF-18 | P1 (C4 + modal) |
| RF-19 | P3 (B5, B6) |
| RF-20 | P6 (H7) + P1 (pantalla) |
| RF-21 | P4 (E3) |
| RF-25, 26, 27 | P5 (G1–G3) |
| RF-28 | P5 (G4) |
| RF-29 | P5 (G5, G8) + P6 (API) |

---

## 6. Cronograma

> Supone entrega el **domingo 15-nov**. Si hay más tiempo, ampliar la Fase 2.
> **Ruta crítica:** AMIs Packer → módulo IaC → cloud-init/Ansible → worker → creación E2E. Mientras las AMIs no existan, el IaC usa una AMI de Ubuntu estándar + cloud-init; se cambia por las AMIs con una sola variable (B7).

### Fase 0 — Jueves 12 (noche, ~2 h): arranque
- **Todos:** leer requisitos y mockup; cerrar las decisiones de §12; repo creado.
- **P1:** accesos AWS para todos, bucket de estado, presupuesto; empezar capa base.
- **P3:** **lanzar el primer `packer build`** (tarda; es la ruta crítica).
- **P6:** publicar el contrato de API (§7) y el esquema de BD; esqueleto API + worker con un trabajo "dummy".
- **P2:** definir la interfaz `EngineAdapter` y el JSON de variables del tenant.
- **P4:** congelar la tabla de planes/límites; listar cambios necesarios a la app.
- **P5:** levantar Prometheus + Grafana en local (Docker) para avanzar dashboards sin esperar a AWS.
- **Hito M0:** contratos acordados, repo y accesos listos.

### Fase 1 — Viernes 13: piezas en paralelo (cada uno prueba lo suyo aislado)
- **P1:** módulo `tenant` desplegando 3 EC2; capa base; estado y SSM funcionando.
- **P2:** adaptador Terraform/OpenTofu; primer borrador de Pulumi; wizard con datos simulados.
- **P3:** AMIs de los 3 roles + monitoreo con exporters; cloud-init por rol.
- **P4:** roles Ansible; app con límites, `/health`, `/metrics`; pantalla Planes.
- **P5:** `ec2_sd` + dashboards + 1 alerta; elegir y ejecutar los 3 escáneres.
- **P6:** API de tenants/operaciones, worker ejecutando CLI real con logs, auditoría.
- **Hito M1 (viernes noche):** cada pieza funciona sola. Demo interna de 20 min.

### Fase 2 — Sábado 14: integración y ciclo de vida
- **Mañana — Hito M2:** crear un tenant **de punta a punta desde la UI con Terraform** (AMIs → cloud-init → Ansible → health check → URL → Grafana).
- **Tarde:**
  - P1: suspender/reanudar, cambio de plan, eliminar con vista previa, OpenTofu.
  - P3: respaldar/restaurar.
  - P5: alertas por webhook hacia la plataforma, escáneres visibles en la UI, Netdata/OTel.
  - P2: Pulumi y CloudFormation creando un tenant Básico; registro de versiones.
  - P6: reintentos, errores comprensibles, filtros, progreso por etapas.
  - P4: actualización de app (RF-15), pruebas de aislamiento.
- **Hito M3 (sábado noche):** todo el ciclo de vida funciona con Terraform; alerta visible.

### Fase 3 — Domingo 15: cierre
- **Mañana:** Pulumi/CloudFormation terminados; pruebas de aislamiento con evidencia; **congelar código a mediodía**.
- **Tarde:** diagrama, manual y comparación finales (la mayoría ya escrita "sobre la marcha"); ensayo de la demo con tenants de prueba; grabar el video; **el líder sube el documento**.
- **Hito M5:** entrega.
- **Siempre:** destruir/detener recursos de prueba al terminar el día (A7).

---

## 7. Contratos de integración (acordar en el kickoff)

**Etiquetas obligatorias en todos los recursos AWS:** `Tenant`, `Env`, `Role` (`frontend|backend|db|monitoring`), `Plan`, `ManagedBy` (`terraform|tofu|pulumi|cloudformation`).

**Variables del tenant (entrada común a todos los motores):**
```json
{
  "tenant_id": "san-marcos",
  "name": "Instituto San Marcos",
  "env": "prod",
  "region": "<region>",
  "plan": "standard",
  "engine": "terraform",
  "contact_email": "admin@sanmarcos.edu",
  "timezone": "America/La_Paz",
  "sizing": { "frontend": "t3.micro", "backend": "t3.small", "db": "t3.small", "db_disk_gb": 50 },
  "limits": { "max_students": 1000, "max_teachers": 50, "max_courses": 100 },
  "ami": { "frontend": "ami-…", "backend": "ami-…", "db": "ami-…" },
  "suspended": false
}
```

**Salida común del adaptador:** `{ status, resources[], outputs{urls, instance_ids, private_ips}, tool_versions{}, log_ref }`.

**Puertos (los SG de los tenants solo permiten el SG del monitoreo):**

| Servicio | Puerto |
|---|---|
| node_exporter | 9100 |
| process_exporter | 9256 |
| OpenTelemetry collector (métricas) | 8889 |
| Netdata | 19999 |
| Prometheus | 9090 |
| Grafana | 3000 |
| Backend `/metrics` y `/health` | puerto del backend |

**Endpoints mínimos de la API:**
`POST/GET /tenants` · `GET /tenants/:id` · `POST /tenants/:id/{suspend,resume,upgrade,backup,restore,retry}` · `POST /tenants/:id/plan-change/preview` y `/plan-change` · `GET /tenants/:id/delete-preview` · `DELETE /tenants/:id` · `GET /operations/:id/logs` · `GET/PUT /plans` · `POST /alerts/webhook` · `GET /alerts` · `GET /audit` · `GET /tenants/:id/security`.

---

## 8. Catálogo de planes (propuesta, ajustable)

Los topes de estudiantes, disco y respaldos salen del mockup; el resto es propuesta para cerrar en el kickoff.

| | Básico | Estándar | Avanzado |
|---|---|---|---|
| Estudiantes máx. | 100 | 1.000 | 5.000 |
| Docentes / cursos máx. | 10 / 20 | 50 / 100 | 200 / 500 |
| Frontend | t3.micro | t3.micro | t3.small |
| Backend | t3.micro | t3.small | t3.medium |
| Base de datos | t3.micro | t3.small | t3.medium |
| Disco de BD | 10 GB | 50 GB | 200 GB |
| Respaldo | Semanal | Diario | Diario + retención 30 días |

**Política de suspensión (propuesta):** detener las 3 EC2, conservar discos EBS y datos; la reanudación vuelve a arrancar las instancias. Cuidado: al reanudar la **IP pública cambia**, por eso el backend y la BD se conectan por IP privada y la plataforma actualiza la URL/targets al reanudar.

---

## 9. Pruebas y evidencias

**Criterios mínimos de aceptación → qué se demuestra**

| Criterio | Evidencia |
|---|---|
| Crear tenants con distintos planes | 2–3 tenants creados (Básico/Estándar/Avanzado) con tamaños distintos |
| Frontend + backend + BD por tenant | 3 EC2 por tenant en consola/IaC + URL funcionando |
| Cambiar plan y explicar efecto | Vista previa (qué se redimensiona, downtime) + resultado |
| Suspender y reanudar conservando datos | Registrar estudiante → suspender → reanudar → el dato sigue |
| Respaldar y restaurar | Backup → borrar un dato → restore → el dato vuelve |
| Salud en Grafana + alerta de ejemplo | Dashboard por tenant/entorno + alerta disparada y visible en la plataforma |
| Aislamiento entre tenants | Script `tests/isolation.sh` (abajo) |
| Operación fallida: historial + reintento | Provocar un fallo controlado → ver log sin secretos → reintentar sin duplicar |

**Pruebas de aislamiento (J5):**
1. Desde el backend del tenant A, intentar conectar a la BD del tenant B → debe fallar (SG).
2. Credenciales de BD de B contra la BD de A → deben fallar.
3. Token/sesión del tenant A contra la API del tenant B → debe ser rechazado.
4. Instancia de A intenta leer `/tenants/B/...` en SSM → denegado (IAM).
5. Un dato creado en A no aparece en la UI ni en la BD de B.
6. (C) El admin de tenant solo ve su tenant en la plataforma/Grafana.

---

## 10. Video y entrega

- **Máx. 15 min por grupo**, solo pantalla + código (sin cámara). El **líder** sube el documento con nombres, nombre del equipo y link.
- **Guion sugerido:**

| Min | Contenido | Quién |
|---|---|---|
| 0:00–1:30 | Arquitectura y flujo de creación, función de cada herramienta | P1 |
| 1:30–4:30 | Crear tenant en el wizard (selector de motor), progreso y logs | P2 + P6 |
| 4:30–6:30 | Cambio de plan, suspender/reanudar, respaldar/restaurar, eliminar con confirmación | P1 + P3 |
| 6:30–8:30 | Grafana por tenant/entorno, alerta de ejemplo, escáneres | P5 |
| 8:30–9:30 | Aislamiento entre tenants y fallo + reintento | P4 + P6 |
| 9:30–14:30 | **Código, ~50 s por persona:** "esto hice y por qué" (P1…P6) | todos |
| 14:30–15:00 | Cierre | P1 |

- La parte de React se muestra rápido: el docente indicó que no suma mérito.

---

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Poco tiempo (≈3,5 días) | Priorizar **M**; Pulumi/CFN solo plan Básico; documentar sobre la marcha; congelar código el domingo al mediodía. |
| Los `packer build` tardan y bloquean todo | Lanzarlos la primera noche; mientras tanto el IaC usa AMI estándar + cloud-init. |
| Cuota de vCPU / costos (n tenants × 3 EC2 + monitoreo) | Revisar cuota hoy; instancias t3 pequeñas; A7 para destruir lo de prueba; presupuesto con alerta. |
| Internet lento (descarga de providers) | Caché de plugins de Terraform y AMIs ya construidas. |
| Secretos en el estado o en logs | Secretos generados fuera del IaC + SSM + redacción en el worker + bucket cifrado. |
| Dos operaciones a la vez sobre un tenant | Lock por tenant en el worker + bloqueo de estado. |
| La IP pública cambia al reanudar | Conexión interna por IP privada; actualizar URL/targets al reanudar. |
| Prometheus no ve instancias nuevas | `ec2_sd` + etiquetas obligatorias + rol IAM con `DescribeInstances` (probar el viernes). |
| Alguien queda como "solo frontend" | Reparto §4 + suplentes + `CONTRIBUCIONES.md`. |

---

## 12. Decisiones a cerrar en el kickoff (hoy)

- [ ] Confirmar la fecha de entrega con el docente (¿domingo 15?).
- [ ] Región de AWS y quién crea cuenta/usuarios/presupuesto.
- [ ] Tabla final de planes y límites (§8).
- [ ] Motor de BD de la app y cómo se respalda (dump + snapshot).
- [ ] Política de suspensión y retención (cuántos días se conservan los datos de un tenant suspendido).
- [ ] Cómo se actualiza la app: Ansible vía SSM o SSH desde el worker.
- [ ] Lenguaje de Pulumi (el mismo del backend, si es posible).
- [ ] Los 3 escáneres concretos (sugerencia: Checkov/tfsec, Trivy, Gitleaks).
- [ ] Canal de alertas (webhook obligatorio + Telegram o correo).
- [ ] Convención de nombres: `tenant_id`, etiquetas, prefijos de SSM y claves de estado.
