# P5 — Observabilidad y escáneres de seguridad

Esta carpeta contiene el código de observabilidad y el registro de implementación de G1–G9. Las integraciones con la interfaz, el worker y PostgreSQL reutilizan los módulos de `platform/`. El [plan](../docs/Plan_de_implementacion_Tenant_Control_Center.md#3-lista-completa-de-trabajo-qué-hace-falta) y el [contrato de integración](../docs/contratos-integracion.md#puertos-que-deben-conservarse) definen los entregables y los puertos.

| Paso | Cambios | Verificación |
| --- | --- | --- |
| G1 | `prometheus/config.mjs` genera la configuración local o de AWS. EC2 se descubre por VPC, `Project`, rol y entorno. Cada target recibe `tenant`, `env` y `role`. | Comprobar configuración con `promtool` y revisar targets. |
| G2, G3, G7 | Un dashboard Grafana versionado muestra roles, disponibilidad del scrape, proceso PostgreSQL, recursos, métricas HTTP, event loop, heap y series de OTel y Netdata. | Probar los filtros con `demo-a` y `demo-b` en local. Repetir con las tres EC2 de un tenant en AWS. |
| G4, G5 | Grafana aprovisiona cinco reglas y envía al webhook existente. La API traduce lotes, aplica el tenant y entorno de cada evento y evita duplicados por huella y hora de inicio. | Probar una alerta y comprobar el historial en Monitoreo. |
| G6 | La etapa previa a la creación ejecuta Checkov, Trivy y Gitleaks. Se guarda el resultado por operación y herramienta en las tablas existentes. | Activar la etapa y crear una institución de prueba. |
| G8 | Inicio autenticado, estado y alertas en Monitoreo, enlace a Grafana con el filtro del tenant y pestaña Seguridad en el detalle. | Ejecutar lint y build. Revisar el acceso con administrador de plataforma y de institución. |
| G9, J3, J5, J8 | Verificación local y en AWS registrada en esta guía. Atribución en [Contribuciones](../CONTRIBUCIONES.md#p5--observabilidad--escáneres-de-seguridad-fabiana). | La alerta de ejemplo se verificó en AWS. Quedan por adjuntar las capturas del tablero y de la alerta para J3. |

## Evidencia local del 15/11/2026

- Prometheus 2.54.1 validó las configuraciones local y EC2 con `promtool`. El entorno local respondió con 27 targets sanos, 13 por tenant simulado y uno de Prometheus.
- Grafana cargó 12 paneles y cinco reglas. Una ráfaga de 100 respuestas 500 de `demo-b` llegó por webhook y se guardó en PostgreSQL para `demo-b/test`. La sesión de administración de `demo-a` solo recibió sus alertas y obtuvo 404 al consultar la seguridad de `demo-b`.
- Los escáneres devolvieron tres filas asociadas a una operación, con 34 hallazgos de Checkov, cuatro de Trivy y cero de Gitleaks. Checkov y Gitleaks revisaron `attendance-platform` en `cec9bab`. Trivy revisó el lockfile de `attendance-core` en `ecf3f46`. Los recuentos dependen de la revisión y de la base de vulnerabilidades.
- API y worker, 87 pruebas aprobadas y dos omitidas por plataforma. También pasó el lint y la compilación de React. La prueba de recepción y aislamiento usó una base PostgreSQL temporal.

## Evidencia AWS del 15/11/2026

- Se construyeron las cuatro AMIs 0.2.3. El panel de integración usó una base PostgreSQL local separada y un perfil autorizado para la cuenta de prueba en Ohio.
- El tenant `demo-a/test` se aprovisionó con Terraform. Prometheus descubrió frontend, backend y PostgreSQL sin agregar targets estáticos. Los 13 targets del tenant estaban `up`, incluidos OpenTelemetry y Netdata.
- Grafana 13.3.1 cargó el tablero versionado con 12 paneles. En Seguridad se verificaron los resultados del aprovisionamiento real. Checkov registró 34 hallazgos, Trivy registró 4 y Gitleaks terminó sin hallazgos.
- Para esta demo se usó un túnel SSH limitado a dos conexiones de loopback, una para Grafana y otra para el webhook. La EC2 de monitoreo obtuvo HTTP 201 al probar el webhook por el túnel. El relay local mantiene el token de servicio en la PC y solo reenvía la ruta de alertas. El túnel debe seguir abierto durante la grabación.
- La ruta de demo del backend produjo respuestas HTTP 500 en distintos intervalos de scrape. Grafana evaluó la regla 5xx como `firing` y la API confirmó que la alerta crítica quedó guardada para `demo-a/test`. El panel de integración de la demo escuchó en `localhost:5174` y el túnel a Grafana en `127.0.0.1:13000`.

## 1. Levantar observabilidad en local

Desde la raíz del repositorio, con Docker Desktop abierto.

```powershell
node observability/prometheus/config.mjs --mode local --out observability/.local/prometheus.json
docker compose -f observability/compose.yaml up -d --wait
docker compose -f observability/compose.yaml exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
```

- Prometheus queda en [127.0.0.1:9090/targets](http://127.0.0.1:9090/targets).
- El tablero queda en [127.0.0.1:3000/d/attendance-tenants](http://127.0.0.1:3000/d/attendance-tenants). El primer inicio usa las credenciales locales predeterminadas de Grafana y pide el cambio de contraseña.
- Los contenedores `demo-a` y `demo-b` simulan los endpoints de las tres EC2 de cada institución. En AWS se usan los exporters de las AMIs y `http://IP_PRIVADA:5000/core/api/v1/metrics` del backend.
- El panel de PostgreSQL mide el proceso local a través de Process Exporter. El endpoint `/core/api/v1/health` y el health check existente del despliegue comprueban la conexión real a la BD.

## 2. Probar una alerta local

1. Prepara PostgreSQL, la API y el administrador según [el arranque de plataforma](../platform/README.md#arrancar-en-local). Aplica las migraciones con `pnpm db:migrate`. En el panel registra una institución con identificador `demo-a` y entorno `test`.
2. En la misma sesión de PowerShell, proporciona el mismo `PLATFORM_WEBHOOK_TOKEN` de al menos 24 caracteres a Compose y a la API. Grafana en Docker usa `http://host.docker.internal:5001/api/v1/alerts/webhook` por defecto. Si usas otra dirección accesible desde el contenedor, configura `PLATFORM_ALERT_WEBHOOK_URL`. Reinicia Grafana con `docker compose -f observability/compose.yaml up -d --wait` para tomar esos valores.
3. Provoca 500 en `demo-a` y comprueba que la regla aparezca disparada en Grafana y que Monitoreo registre la institución `demo-a/test`.

```powershell
docker compose -f observability/compose.yaml exec -T demo-a node -e "Promise.all(Array.from({length:100}, () => fetch('http://127.0.0.1:5000/core/api/v1/demo/error'))).then(r => console.log(r.filter(x => x.status === 500).length))"
```

La regla usa una ventana de dos minutos, un mínimo de diez peticiones y más del 5 % de respuestas 5xx durante 30 segundos. Las reglas operativas evalúan scrape caído, CPU superior al 60 %, memoria superior al 80 % y disco sobre el 85 %. EC2 discovery incorpora instancias encendidas. Una instancia que sale del descubrimiento deja de tener series `up`; la vista conserva el estado de ciclo de vida que registra el panel.

Para el enlace web a Grafana, añade `VITE_GRAFANA_URL=http://127.0.0.1:3000` a la configuración local de `platform_web` y reinicia Vite o reconstruye el frontend.

## 3. Probar los tres escáneres

En el entorno del worker configura `PLATFORM_SECURITY_SCANS=true` y `PLATFORM_SCAN_CORE_REF` con el SHA completo del backend. Para la AMI de la integración 0.2.2, el core documentado es `ecf3f46d0e9f865c9e5124121100032a099fb534`. El clonado local de `attendance-core` debe estar junto a `attendance-platform`.

Crea una institución desde el asistente. En modo local, deja marcado **Simular el aprovisionamiento al confirmar**. Guardarla como borrador solo registra la institución. Los escáneres se ejecutan al iniciar su aprovisionamiento. Debe aparecer la etapa **Escaneando seguridad** y, en **Seguridad**, los tres resultados con la revisión analizada. El alcance de cada herramienta es el siguiente.

- **Checkov** revisa el HCL de Terraform/OpenTofu y la plantilla CloudFormation versionados. El JavaScript de Pulumi queda fuera de esa cobertura IaC.
- **Trivy** revisa dependencias de `attendance-core` en el lockfile de la revisión seleccionada. La prueba no realiza un escaneo de snapshots EBS.
- **Gitleaks** revisa los archivos versionados de `attendance-platform`. Solo se guardan regla, archivo y línea de un hallazgo.

Se conserva el total y se muestran hasta cien hallazgos por resultado. Un fallo de herramienta queda visible como error de ejecución. El flujo sigue y conserva el resultado para su revisión. La primera ejecución descarga las imágenes fijadas y la base de vulnerabilidades de Trivy.

## 4. Aplicar en AWS cuando esté lista la integración

En la cuenta y región de la demo, usa la VPC del output `integration` de P1. La instancia `monitoring` debe usar su perfil IAM existente para describir las EC2 y tener un acceso autorizado por SSM.

```powershell
$base = Get-Content .local/base.outputs.json -Raw | ConvertFrom-Json
node observability/prometheus/config.mjs --mode aws --region $base.region --vpc $base.vpc_id --project $base.project_name --out observability/.local/prometheus.aws.json
```

Transfiere a esa EC2 `apply-monitoring.sh`, `grafana/` y el archivo generado por el canal de administración aprobado por el equipo. En la instancia, el archivo `/etc/attendance/observability.env` debe pertenecer a root, con modo `0600` y las variables `PLATFORM_ALERT_WEBHOOK_URL` y `PLATFORM_WEBHOOK_TOKEN`. La URL debe alcanzar el webhook desde la EC2 por la conectividad aprobada. Una dirección `127.0.0.1` en la EC2 apunta a la propia instancia.

```bash
sudo bash apply-monitoring.sh prometheus.aws.json
```

El script valida la configuración de Prometheus, instala el tablero y el provisioning y recarga los servicios de la EC2. Comprueba luego `/-/ready` en Prometheus y `/api/health` en Grafana. Crea un tenant `test` desde el panel, verifica que se incorporen sus tres roles automáticamente y registra la prueba de la alerta real con `/core/api/v1/demo/error`. Para J5, verifica que el administrador de un tenant vea exclusivamente sus alertas y sus escaneos en la API. Grafana compartido se enlaza desde la vista de operador.
