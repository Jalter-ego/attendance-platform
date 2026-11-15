# Plataforma local con AWS real

Ejecuta los comandos desde la raíz del repositorio con PowerShell 7. El panel y la API escuchan en `http://127.0.0.1:4100`; el worker es otro proceso local. El modo `integration` aprovisiona recursos AWS reales al solicitar operaciones desde el panel. Iniciar los procesos no solicita crear tenants.

Requisitos: Node 22.13+, pnpm, PostgreSQL 17 en `C:\Program Files\PostgreSQL\17\bin`, Git Bash, OpenTofu, Terraform en `.local/tools/terraform/terraform.exe`, Pulumi y credenciales AWS del perfil `default` para Ohio (`us-east-2`). Instala dependencias de API y panel con pnpm antes del primer arranque. La infraestructura base debe exportarse a `.local/base.outputs.json` y las AMIs a `infra/packer/ami-ids.json`. El bucket de estado configurado en `.env` debe existir para Terraform/OpenTofu y el backend S3 de Pulumi.

```powershell
pnpm --dir platform/platform_web build
pwsh -File platform/scripts/start-local.ps1
pwsh -File platform/scripts/start-local.ps1 -Action Status
pwsh -File platform/scripts/start-local.ps1 -Action Stop
```

El primer arranque inicializa un cluster PostgreSQL dedicado en `.local/postgres`, ligado exclusivamente a `127.0.0.1:5434`, y crea `attendance_platform_integration`. No usa el servicio PostgreSQL existente. Si ese puerto ya está ocupado, utiliza `-PostgresPort 5435` en el primer arranque. Se generan contraseñas aleatorias; el script crea `platform/platform_api/.env` solo si aún no existe y conserva su contenido en siguientes arranques. Las credenciales de acceso quedan en `.local/demo-access.txt`. Estos archivos y el cluster están ignorados por Git y deben mantenerse privados.

Las migraciones y el alta inicial se ejecutan antes de iniciar API/worker. La creación del administrador es idempotente: no cambia contraseñas de administradores existentes. Los procesos se inician ocultos y por separado; sus logs quedan en `.local/logs/`. `-SkipWorker` permite revisar solo el panel/API mientras se termina la infraestructura.

Los scripts de salud con versiones y los respaldos requieren `jq` local. En esta instalación está en `.local/tools/jq/jq.exe`; el arranque añade esa carpeta al PATH de API/worker. No basta con tener jq dentro de las AMIs.

Para procesar trabajos de distintos tenants en paralelo, se puede iniciar con `-WorkerCount 2`. La cola sigue impidiendo dos operaciones activas para el mismo tenant. El número de workers no amplía las cuotas de AWS: elegirlo de acuerdo con la capacidad de la cuenta.

`Stop` verifica el PID, la hora de creación y la línea de comando guardados en `.local/processes.json` antes de detener cada proceso. PostgreSQL se detiene mediante `pg_ctl` dirigido únicamente al cluster `.local/postgres`. No se detienen servicios Windows ni otros procesos Node/PostgreSQL.

Para cambios de frontend, vuelve a ejecutar `pnpm --dir platform/platform_web build`. Tras cambios de API/worker o `.env`, detén e inicia los procesos. No cambies el modo de despliegue de una base existente: usa una base separada para simulación. La prueba `test:e2e:local` exige modo `local`; la prueba `test:integration` utiliza una base desechable `platform_test*` y adaptadores falsos, sin crear recursos AWS.
