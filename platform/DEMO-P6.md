# Demostración de P6: panel local, tenants reales en AWS

## Qué se ejecuta dónde

El panel React, la API Express, PostgreSQL de la plataforma y el worker se ejecutan en la PC. No se despliega el control center en EC2. Cada tenant creado desde el asistente tiene sus propias EC2 de frontend, backend y PostgreSQL, además de un disco EBS independiente para sus datos.

La base compartida de AWS proporciona VPC, subredes, endpoints SSM/S3 y almacenamiento de estado y respaldos. Es infraestructura de soporte de los tenants, no un despliegue del panel.

## Arrancar en esta PC

Desde la raíz del repositorio, en PowerShell 7:

```powershell
pwsh -File platform/scripts/start-local.ps1
```

Abrir `http://127.0.0.1:4100/login`. Las credenciales privadas de esta instalación están en `.local/demo-access.txt`. No se publican en Git. El script inicia API y worker separados y un cluster PostgreSQL dedicado en el puerto 5434; no cambia el servicio PostgreSQL que ya tiene Windows.

```powershell
pwsh -File platform/scripts/start-local.ps1 -Action Status
pwsh -File platform/scripts/start-local.ps1 -Action Stop
```

La última orden detiene los procesos locales de esta instalación. No detiene instancias AWS. Para suspender un tenant se usa la acción del panel.

## Crear desde el panel

1. Instituciones → Registrar institución.
2. Escribir nombre, identificador y correo de administrador. Usar entorno Pruebas para la demostración y Ohio como región de esta instalación.
3. Seleccionar un plan y uno de los cuatro motores.
4. Revisar los recursos previstos y mantener marcada **Crear la infraestructura al confirmar**.
5. Confirmar. La API registra y encola en la misma transacción; el detalle muestra etapas y eventos mientras el worker ejecuta el motor.
6. Esperar el estado disponible. La URL, los IDs de las tres EC2, el EBS y las versiones quedan en el historial de infraestructura. El estado disponible exige salud del frontend y de la API conectada a PostgreSQL.

No iniciar el mismo tenant manualmente con otro motor. El motor, la configuración y el estado quedan fijados por tenant. Para comparar herramientas, crear tenants con identificadores distintos.

La cuenta de la plataforma y la cuenta inicial de la aplicación de un tenant son distintas. En la app del tenant se usa el correo que se indicó en el asistente. Su contraseña inicial se genera en SSM; un operador autorizado puede consultarla en su propia terminal, reemplazando el identificador:

```powershell
aws ssm get-parameter --region us-east-2 --name /tenants/IDENTIFICADOR/test/admin_password --with-decryption --query Parameter.Value --output text
```

La contraseña no aparece en los logs ni en la auditoría del panel.

## Motores

| Motor | Implementación | Estado |
| --- | --- | --- |
| Terraform | Módulo HCL `infra/terraform/tenant` | S3 por tenant/entorno, con bloqueo |
| OpenTofu | Mismo módulo HCL, ejecutable `tofu` | S3 por tenant/entorno, con bloqueo |
| CloudFormation | `infra/cloudformation/tenant.yaml`, AWS SDK | Stack AWS por tenant/entorno |
| Pulumi | Programa Node `infra/pulumi/tenant` y adaptador CLI | Backend S3, stack por tenant/entorno |

Los cuatro permiten crear las tres EC2, suspender, reanudar y eliminar con vista previa. Actualización y cambio de plan están disponibles con Terraform/OpenTofu; CloudFormation/Pulumi los rechazan explícitamente y el panel no los ofrece.

## Qué mostrar para defender P6

- **Transacción de registro y encolado:** `platform_api/src/modules/operations/operations.service.js`.
- **Exclusión por tenant y recuperación del worker:** `platform_api/src/worker/queue.js` y el índice `operations_one_active_per_tenant` de las migraciones.
- **Comandos, cancelación y secretos ocultos:** `platform_api/src/worker/services/command-runner.js` y `platform_api/src/lib/redact.js`.
- **Creación real:** `platform_api/src/worker/handlers/create.handler.js`. Preflight → SSM → apply → guardar inventario → salud → publicación final.
- **Configuración estable para reintentar:** `platform_api/src/modules/deployments/deployment-config.js`.
- **Registro común de los cuatro motores:** `platform_api/src/engines/adapter.js`.
- **Auditoría:** `platform_api/src/modules/audit/audit.service.js`.

Texto sugerido:

> La plataforma corre localmente. Al confirmar el asistente, registro la institución y encolo su trabajo en una transacción. Un worker separado usa el motor elegido para crear sus tres servidores. PostgreSQL impide dos operaciones activas para el mismo tenant. El worker conserva configuración, inventario y estado para reintentar sin duplicar recursos, filtra secretos en los logs y solo publica el tenant como disponible después de comprobar su salud. Puedo mostrar quién inició cada operación y cómo terminó.

## Reintento y conservación de datos

Ante una operación fallida, abrir su historial, corregir la causa y pulsar **Reintentar** en esa operación. No borrar el tenant, sus directorios de ejecución ni su estado para volver a intentarlo. Si una operación se cancela, comprobar primero el estado remoto: el motor puede seguir procesando un paso que ya comenzó.

La validación real detectó dos diferencias respecto de las pruebas con dobles: al detener EC2, su asociación pública aparece temporalmente como ausente, y OpenTofu convierte la identidad del proveedor en la copia de su lockfile. El módulo conserva la configuración de lanzamiento del frontend sin reemplazarlo por esa lectura temporal. El worker permite la conversión de OpenTofu dentro del directorio del tenant, conservando la versión seleccionada y el estado. La protección contra reemplazar máquinas o el disco durante suspensión/reanudación sigue activa.

Para demostrar persistencia, crear un dato, suspender, reanudar y comprobar que continúa. La IP pública puede cambiar; la plataforma debe actualizar la URL sin cambiar las EC2 ni el volumen de datos.

## Prueba automatizada real, voluntaria

Esta prueba crea recursos AWS reales. Desde la raíz del repositorio:

```powershell
node --env-file=platform/platform_api/.env platform/platform_api/tests/aws.e2e.js --allow-aws --engine=tofu
```

Se puede usar `terraform`, `tofu`, `cloudformation` o `pulumi`. Requiere API y worker activos y el entorno de integración preparado. El script crea un tenant `p6-check-*`, espera salud, escribe un marcador de prueba en su PostgreSQL mediante SSM, suspende/reanuda y compara EC2, EBS y datos. Por defecto vuelve a suspender el tenant al terminar; `--keep-running` conserva su ejecución. La evidencia queda en `.local/aws-evidence/`.

También puede validar un tenant creado previamente desde el navegador mediante `--tenant-file=.local/<archivo>.json`, con el resultado `{tenant,operation}` de la solicitud. `--retry` comprueba una creación que falló después de guardar recursos: exige que las EC2 del intento anterior se reutilicen.

La prueba no usa las instancias compartidas del equipo ni tenants ajenos. Exige identificador `p6-check-*` y entorno `test`. El marcador se escribe en una tabla de prueba separada, `public.p6_validation`.

## Pruebas sin crear AWS

```powershell
pnpm --dir platform/platform_api test
pnpm --dir platform/platform_web lint
pnpm --dir platform/platform_web build
npm --prefix infra/pulumi/tenant test
```

La suite de integración con PostgreSQL y dobles requiere una base local exclusiva `platform_test*`; reconstruye su esquema y nunca debe apuntar a la base de la demo. Los resultados de pruebas con dobles no sustituyen la evidencia AWS real.

## Conservación de configuración

Mantener `.env`, la passphrase de Pulumi, `.local/base.outputs.json` y los directorios `.local/runs`. Las contraseñas de la aplicación viven en SSM, fuera del código y de los estados del motor. El catálogo de AMIs debe corresponder a la cuenta y región de esta instalación.

El stack `attendance-cfn-team` ya existente es independiente de los tenants creados por esta plataforma. No se adopta ni se modifica automáticamente.
