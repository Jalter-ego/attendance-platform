# Manual de usuario — Respaldos y servidores de cada institución (P3)

Sección de P3 para el manual (J4), que compila P6. Está dirigida al **administrador de plataforma**. Los pasos marcados como **operador** se hacen desde una consola con las credenciales de AWS de la plataforma.

## 1. Qué se respalda

Cada respaldo guarda **dos copias** de la base de datos de una institución:

| Copia | Qué es | Para qué sirve |
|---|---|---|
| **Volcado (S3)** | Un archivo con todo el contenido de la base (`pg_dump`), cifrado y guardado en S3, en la carpeta de esa institución y entorno | Es la copia que se usa para **restaurar** desde la plataforma |
| **Snapshot (EBS)** | Una foto del disco completo de la base de datos | Recuperar el disco entero si hiciera falta (lo hace el operador desde AWS) |

La aplicación de la institución **sigue funcionando** mientras se respalda.

## 2. La pantalla Respaldos

Menú lateral → **Respaldos**. También desde **Instituciones** → detalle de la institución → **Respaldos**.

Arriba a la derecha, elige la institución (nombre · identificador/entorno). La pantalla muestra:

- **Datos de la institución:** identificador, estado, bucket donde se guardan los volcados y cuántos respaldos tiene.
- **Respaldar ahora:** el botón para crear un respaldo en el momento.
- **Respaldos disponibles:** la tabla de respaldos (sección 4).
- **Operaciones de respaldo:** el historial de respaldos y restauraciones, con su progreso y sus eventos.

> **Modo local.** Si la plataforma corre en modo local (`PLATFORM_DEPLOY_MODE=local`), la pantalla dice *"Copias simuladas"*: los respaldos se simulan y no se crean volcados ni snapshots reales. En modo `integration` se usan los respaldos reales que describe este manual.

## 3. Respaldar ahora

1. Elige la institución. Debe estar **Disponible**; si no lo está (creándose, suspendida o con error), el botón queda desactivado y aparece el aviso *"Activa el tenant para crear o restaurar un respaldo"*.
2. Pulsa **Respaldar ahora**.
3. Sigue el progreso en **Operaciones de respaldo**. Las etapas son:

   | Progreso | Etapa |
   |---|---|
   | 10 % | Buscando la VM db |
   | 30 % | Volcando la base en la VM db |
   | 55 % | Subiendo el volcado a S3 |
   | 75 % | Creando snapshot EBS |
   | 95 % | Registrando el respaldo |
   | 100 % | Respaldo listo |

4. Al terminar, el respaldo aparece en la tabla. Suele tardar menos de un minuto.

Mientras una operación está en curso, la institución no acepta otra (el botón dice *"Hay una operación pendiente"*). Así un respaldo nunca se cruza con una restauración o un despliegue.

## 4. La tabla de respaldos

| Columna | Qué muestra |
|---|---|
| **Fecha** | Cuándo se hizo, y debajo su identificador (por ejemplo `20261114T175003Z-manual`) |
| **Tipo** | **Manual** (con «Respaldar ahora»), **Programado** (automático, según el plan), **Previo a restaurar** (copia que se guarda sola antes de cada restauración) o **Solo snapshot (DLM)** (snapshot automático de AWS sin volcado) |
| **Volcado (S3)** | Tamaño del archivo |
| **Snapshot (EBS)** | Identificador del snapshot y su estado (`pending` mientras se crea, `completed` cuando está listo) |
| **Acciones** | **Restaurar**, solo en los respaldos que tienen volcado |

El botón de actualizar (arriba a la derecha de la tabla) vuelve a consultar S3 y EBS. La tabla también se actualiza sola cuando termina un respaldo o una restauración.

## 5. Restaurar un respaldo

Restaurar devuelve la base de datos de la institución **al momento de ese respaldo**.

1. En la fila del respaldo, pulsa **Restaurar**.
2. Lee el aviso: los cambios hechos después de esa fecha se pierden.
3. Escribe el **identificador de la institución** (por ejemplo `san-marcos`) para confirmar y pulsa **Restaurar**.
4. Sigue el progreso en **Operaciones de respaldo**: *Restaurando en la VM db* → *Copia previa a la restauración* → *Restauración terminada*.

Qué pasa en el servidor, en este orden:

1. Se guarda una copia **Previo a restaurar** de la base tal como está ahora, para poder deshacer.
2. Se descarga el volcado y se comprueba que no esté dañado (sha256). Si no coincide, **no se restaura**.
3. Se cierran las conexiones de la aplicación a la base. Los usuarios conectados pueden ver un error unos segundos; la aplicación se reconecta sola.
4. Se restaura en **una sola transacción**: si algo falla, la base queda exactamente como estaba.

> **Para deshacer una restauración**, restaura el respaldo **Previo a restaurar** que se creó justo antes.

> **En producción, respalda antes de actualizar el backend** (ver la sección de P4, *Actualizar la aplicación*). Volver a la versión anterior de la aplicación no restaura la base de datos.

## 6. Respaldos automáticos

Cada plan define cada cuánto se respalda y cuántos días se conserva cada respaldo:

| Plan | Frecuencia | Se conservan |
|---|---|---|
| Básico | Semanal (domingo) | 28 días |
| Estándar | Diario | 14 días |
| Avanzado | Diario | 30 días |

- **Volcados programados:** a las 03:00, hora de la institución.
- **Snapshots programados (DLM):** a las 07:00 UTC (03:00 en La Paz).
- Las copias **Previo a restaurar** se conservan 7 días.
- Lo vencido se borra solo: S3 vence los volcados y AWS DLM los snapshots programados. Los snapshots de «Respaldar ahora» los borra el operador con `prune` (sección 8).

La política se toma del plan con el que se creó la institución. Cambiarla requiere cambiar el plan de la institución (sección de P4).

## 7. Cancelar y reintentar

- **Cancelar:** en el panel de la operación. Corta el proceso en la plataforma en unos segundos. Si el volcado ya había empezado en el servidor, termina allí y puede aparecer en la tabla aunque la operación figure como cancelada.
- **Reintentar:** en una operación fallida o cancelada. Repite la misma acción; al restaurar, con el mismo respaldo.

## 8. Comandos del operador

Desde la raíz del repositorio, en **Git Bash**. En PowerShell, cambia `bash` por `& 'C:\Program Files\Git\bin\bash.exe'`: `bash` a secas abre el de WSL, que no tiene las credenciales de AWS.

```bash
# Respaldar (volcado + snapshot)
bash infra/backups/tenant-backup.sh backup  --tenant <id> --env <test|prod>

# Ver los respaldos (JSON con volcados y snapshots)
bash infra/backups/tenant-backup.sh list    --tenant <id> --env <test|prod>

# Restaurar un respaldo concreto, o el último (sin contar las copias previas)
bash infra/backups/tenant-backup.sh restore --tenant <id> --env <test|prod> --id <backup_id|latest>

# Borrar los snapshots manuales vencidos
bash infra/backups/tenant-backup.sh prune   --tenant <id> --env <test|prod>
```

Todo se ejecuta con **SSM Run Command**, sin SSH: la base de datos está en una red privada. La última línea de la salida es siempre un JSON con el resultado.

## 9. Los servidores de cada institución

Cada institución tiene **3 servidores**: frontend (la web), backend (la API) y base de datos. Los tres salen de **imágenes (AMI) construidas con Packer**, iguales para todas las instituciones. La versión vigente está en `infra/packer/ami-ids.json` (0.2.2).

Al encender cada servidor por primera vez, se configura para **su** institución: toma su identidad, lee sus contraseñas de SSM (cada servidor solo puede leer las de su institución) y aplica la configuración con Ansible. En la base de datos, el disco de datos **nunca se borra** si ya tiene información: si se reemplaza el servidor por uno nuevo, los datos se conservan.

### Comprobar que un servidor arrancó bien (operador)

```bash
bash infra/health/tenant-health.sh --tenant <id> --env <test|prod> --boot
```

Para cada servidor muestra el estado del arranque:

| Estado | Significado |
|---|---|
| `ready` | Arrancó y quedó configurado |
| `booting` | Todavía se está configurando (tarda unos 90 segundos) |
| `failed` | Falló; el mensaje dice en qué paso |

Si falló, el registro completo está en el servidor, en `/var/log/attendance-boot.log`. Se puede reintentar sin riesgo con `sudo attendance-boot` (por Run Command): la configuración se puede repetir sin romper nada.

### Nueva versión de las imágenes (operador)

Las imágenes no se modifican: una versión nueva del sistema o de los agentes es **una imagen nueva** (por ejemplo 0.2.3), construida con `packer build` en `infra/packer` (ver su README). Después se actualiza `infra/packer/ami-ids.json`. Las instituciones existentes siguen con su imagen hasta que se reemplazan sus servidores, y el disco de datos se conserva.

## Problemas frecuentes

| Situación | Solución |
|---|---|
| «Respaldar ahora» y «Restaurar» están desactivados | La institución no está **Disponible**. Si está suspendida, reanúdala; si se está creando, espera a que termine |
| *"Hay una operación pendiente"* | Ya hay otra operación en curso en esa institución. Espera a que termine o cancélala |
| *"no hay una VM db en ejecución … (¿suspendido?)"* | El servidor de la base está apagado. Reanuda la institución |
| *"ya hay un respaldo o una restauración en curso"* | Un respaldo programado está corriendo en ese momento. Reintenta en unos minutos |
| *"SSM no aceptó el comando (¿agente registrado?)"* | El servidor no está conectado a SSM. Comprueba con `tenant-health.sh --boot` que arrancó bien |
| *"el sha256 no coincide … no se restaura"* | El volcado está dañado. La base no se tocó: elige otro respaldo |
| *"no existe el respaldo …"* | Ese respaldo ya venció y se borró. Elige otro de la tabla |
| *"No se pudieron consultar los respaldos"* | La plataforma no pudo leer S3 o EBS. Revisa las credenciales de AWS del servidor de la plataforma |
| *"No se encontró bash. Configura BACKUP_BASH"* | En un worker con Windows falta Git Bash o su ruta es otra. Instálalo o configura `BACKUP_BASH` |
| La pantalla dice *"Copias simuladas"* | La plataforma está en modo local. Los respaldos reales necesitan `PLATFORM_DEPLOY_MODE=integration` |
| Apareció un respaldo de una operación cancelada | El volcado ya había empezado en el servidor y terminó allí. Es un respaldo válido |
