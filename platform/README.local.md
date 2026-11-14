# Manual de la demo local de P6

El modo local ejecuta el panel, la API Express y un worker aparte sobre PostgreSQL. Los recursos de cada institución y sus respaldos se simulan. El portal de asistencia de la demo muestra los perfiles de administrador, docente y estudiante como referencia.

Para una instalación nueva sigue [Arrancar en local](README.md#arrancar-en-local). Si ya tienes la demo en [127.0.0.1:4100](http://127.0.0.1:4100), conserva la conexión a PostgreSQL y la cuenta inicial en `platform_api/.env`. Compila el panel con `pnpm build` desde `platform_web/`. En `platform_api/.env` usa esta configuración para servirlo desde Express:

```dotenv
HOST=127.0.0.1
PORT=4100
CLIENT_ORIGIN=http://127.0.0.1:4100
PLATFORM_WEB_DIST=../platform_web/dist
PLATFORM_DEPLOY_MODE=local
```

Aplica `pnpm db:migrate` en `platform_api/` e inicia `pnpm start` y `pnpm worker` en terminales separadas. Entra por la portada con la cuenta de plataforma que ya configuraste.

## Registrar y aprovisionar

1. En **Instituciones**, pulsa **Registrar institución** para abrir **Crear tenant**. Completa el nombre, identificador y correo de contacto. Elige un plan y compara sus límites, disco y política de respaldo.
2. Selecciona entorno, zona horaria y motor. En **Revisión**, comprueba los tamaños y decide si aprovisionar al confirmar o dejar el tenant como borrador. Para iniciar un borrador, abre su detalle y pulsa **Crear infraestructura** cuando ese motor esté disponible.
3. Para practicar la recuperación, activa **Simular un fallo para probar el reintento**. En **Operaciones**, observa el fallo, pulsa **Reintentar** y busca en los eventos el mensaje de reutilización de recursos. El detalle muestra la URL de la demo, el inventario, los servicios y las versiones.

La lista admite filtros por nombre, estado, plan y entorno. Selecciona **Eliminada** para consultar el historial de un tenant borrado. En el detalle también puedes consultar operaciones anteriores y cancelar un trabajo pendiente o en ejecución.

## Operaciones del tenant

| Acción | Pasos |
| --- | --- |
| Actualizar app o infraestructura | Pulsa **Actualizar**, selecciona el alcance, el servicio si actualizas la app y la versión de destino. Revisa la operación y la nueva versión. |
| Suspender y reanudar | Pulsa **Suspender** y espera el estado suspendido. Pulsa **Reanudar**, espera que los servicios estén activos y compara el inventario. |
| Respaldar y restaurar | En **Respaldos**, selecciona la institución y pulsa **Respaldar ahora**. Cuando termine, elige **Restaurar** en una copia disponible, escribe el identificador de la institución y revisa la operación. |
| Cambiar de plan | Pulsa **Cambiar plan** y **Ver vista previa**. Revisa los cambios de recursos y límites, y confirma. En **Planes** se puede editar el catálogo. Si cambió la configuración del plan que ya tiene el tenant, el selector permite aplicar esa revisión. |
| Eliminar | Pulsa **Eliminar** y **Ver vista previa**. Revisa los recursos y datos afectados, marca la confirmación y pulsa **Eliminar** en el formulario. |

## Accesos, auditoría y monitoreo

- En **Administradores del tenant**, abre el formulario para crear una cuenta, cambiar su contraseña, desactivarla o reactivarla. Para probar el alcance de la cuenta, inicia sesión en una ventana privada y consulta su institución. Cambiar la contraseña, desactivar la cuenta o eliminar el tenant revoca sus sesiones.
- En **Auditoría** filtra por tenant o usuario, entorno y resultado. El registro incluye operaciones, cambios de plan en el catálogo, cambios de acceso y solicitudes de cancelación.
- En **Monitoreo** verás las alertas que reciba la API. El detalle muestra los escaneos y sus hallazgos en **Seguridad**. Para probar los receptores habilita `PLATFORM_WEBHOOK_TOKEN` en el entorno del servidor y envía un encabezado `Authorization: Bearer …`. `POST /api/v1/alerts/webhook` acepta `{tenant_id,env,severity,message}`. `POST /api/v1/tenants/:id/security` utiliza el UUID y acepta `{scanner,status,findings}`, con los hallazgos como lista de textos.

## Pruebas y presentación

En `platform_api/` ejecuta `pnpm test` para las pruebas automatizadas. Con una API y un worker en modo local y una base de prueba, usa `pnpm test:e2e:local`. El script crea una institución desechable y conserva su historial. En `platform_web/`, `pnpm build` verifica TypeScript y compila la aplicación.

Para la defensa de P6, muestra el asistente adaptado del flujo de P2, el fallo y reintento sobre el mismo estado, la cola con un trabajo por tenant, los logs del ejecutor con secretos ocultos y el evento en auditoría. Después entra con un administrador de tenant para demostrar el alcance de su sesión. En la [guía de la plataforma](README.md#activación-con-aws) están los parámetros para validar Terraform u OpenTofu con P1/P2 cuando el entorno del equipo esté listo.
