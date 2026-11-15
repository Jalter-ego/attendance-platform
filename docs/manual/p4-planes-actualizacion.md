# Manual de usuario — Planes, límites, actualización y salud (P4)

Sección de P4 para el manual (J4), que compila P6. Está dirigida al **administrador de plataforma**. Cuando algo lo ve el **administrador de una institución** en su app de asistencia, se indica.

## 1. Planes

Menú lateral → **Planes**. Cada tarjeta muestra:

- **Límites de la app:** cuántos estudiantes, docentes y cursos admite la institución. "Sin límite" si no tiene.
- **Infraestructura:** tamaño de los 3 servidores (frontend, backend y base de datos), disco de la base y respaldo (frecuencia y días que se conservan).
- **Versión** del plan (`v1`, `v2`…) y **cuántas instituciones** lo usan. "N en versión anterior" indica cuántas se crearon con una versión más vieja y la conservan.

El catálogo inicial (Básico, Estándar y Avanzado) y qué cuenta cada límite están en [docs/catalogo-planes.md](../catalogo-planes.md).

### Crear un plan
1. **Nuevo plan**.
2. Completa:
   - **Código:** minúsculas, números y guiones. No se puede cambiar después.
   - **Nombre** y **descripción:** se muestran en el asistente Crear tenant.
   - **Límites:** déjalos vacíos para no limitar.
   - **Servidores:** de `t3.micro` a `t3.large`.
   - **Disco de BD:** entre 10 y 1000 GB.
   - **Respaldo:** semanal con 28 días, diario con 14 o diario con 30.
3. **Crear plan**. Aparece enseguida en el asistente **Crear tenant**.

### Editar un plan
1. En la tarjeta del plan, **Editar**. Cambia lo que necesites.
2. Si el plan tiene instituciones, aparece un aviso amarillo con la lista y la versión de cada una. **Esas instituciones no cambian**: conservan sus límites, servidores y respaldo.
3. Marca **"Entendido: las instituciones existentes no se modifican"** y pulsa **Guardar versión nueva**. El plan pasa a la versión siguiente y se aplica a las instituciones que se registren desde ahora.

> **¿Por qué no cambian las existentes?** Aplicar límites o tamaños nuevos recrea o redimensiona sus servidores. Por eso nunca ocurre sin aviso, ni en una suspensión o reanudación posterior.

Si otra persona guardó el plan mientras lo editabas, aparece un aviso para recargar. Así no se pisan los cambios.

### Llevar una institución a la versión nueva del plan
Instituciones → detalle de la institución → **Cambiar plan** → elige su mismo plan con la marca **"Aplicar versión actual"** (u otro plan) → **Ver vista previa**. La vista previa indica qué servidores cambian y si habrá interrupción. Confirma.

### Eliminar un plan
**Eliminar** solo se habilita si ninguna institución usa ni usó el plan. Si ya se usó, edítalo en su lugar.

## 2. Límites del plan en la app (lo ve el administrador de la institución)

La app de asistencia de cada institución hace cumplir los límites de **su** plan:

| Límite | Qué cuenta | Cuándo aparece el aviso |
|---|---|---|
| Estudiantes | Estudiantes de los módulos no archivados | Al importar el Excel de estudiantes de un módulo |
| Docentes | Usuarios activos, incluido el administrador | Al crear o reactivar un usuario |
| Cursos | Módulos en borrador o activos | Al crear un módulo |

Al superarlo, la acción no se realiza y se muestra, por ejemplo: *"Tu plan Básico permite hasta 10 docentes (esta acción llegaría a 11). Para ampliar el límite, solicita un cambio de plan."*

- **Archivar un módulo** libera sus cursos y estudiantes.
- **Para ampliar**, el administrador de plataforma cambia el plan de la institución (sección 1).
- **Uso actual** (soporte): `GET /core/api/v1/plan/usage` con la sesión del administrador de la institución. Devuelve el usado, el límite y lo que queda de cada recurso.

## 3. Actualizar la aplicación de una institución (sin recrear servidores)

Instala una versión nueva del frontend o del backend en los **mismos** servidores. Los datos se conservan y, si la versión nueva falla, vuelve sola a la anterior.

### Antes: preparar y publicar el paquete (operador, una vez por versión e institución)
Desde Linux o WSL, en la raíz del repositorio y con las credenciales de AWS de la plataforma:
```bash
infra/app-update/build-release.sh --component backend --ref develop     # o --component frontend
infra/app-update/tenant-update.sh publish --tenant <id> --env <test|prod> --file dist-releases/backend-<sha12>.tar.gz
```
La versión es el `<sha12>` que muestra el nombre del archivo: los 12 primeros caracteres del commit.

### En la plataforma
1. **Instituciones** → abre la institución, que debe estar **Lista** → **Actualizar**.
2. **Alcance: Aplicación**. Elige el **componente** (Backend o Frontend) y escribe la **versión** (`<sha12>`) → **Actualizar**.
3. Sigue el progreso en el panel de la operación:
   - **Completada:** la versión nueva está activa y pasó el control de salud. El panel **Infraestructura** muestra la versión.
   - **"El paquete falló y Ansible restauró la versión anterior":** la institución sigue funcionando con la versión que tenía. Revisa los eventos y corrige el paquete.

Qué hace en el servidor:
1. verifica el paquete;
2. aplica las migraciones de la base (backend);
3. cambia de versión de forma atómica;
4. reinicia y comprueba la salud;
5. si algo falla, vuelve a la versión anterior.

Se conservan las 3 últimas versiones.

> **En producción, respalda antes de actualizar el backend:** pantalla **Respaldos** → **Respaldar ahora**. Volver a la versión anterior restaura el código, **no la base de datos**.

## 4. Comprobar la salud de una institución

La plataforma la comprueba sola después de **crear**, **reanudar** y **actualizar**. Una institución solo queda **Lista** si responden:

| Comprobación | Qué demuestra |
|---|---|
| `http://<ip>/healthz` | El frontend (nginx) responde |
| `http://<ip>/core/api/v1/health` → `{"status":"ok"}` | La API responde **y** llega a su base de datos |

Si falla, los eventos de la operación indican la causa:

| Mensaje | Qué revisar |
|---|---|
| El frontend no responde | La VM está apagada, arrancando o sin IP pública |
| nginx no llega al backend | La API está caída o todavía arrancando |
| La API no llega a su base de datos | La VM de la base o PostgreSQL |

Para diagnosticarlo a mano (operador):
```bash
infra/health/tenant-health.sh --tenant <id> --env <test|prod> --boot
```
`--boot` agrega el estado del arranque de cada servidor: listo, arrancando o falló, con el motivo.

## 5. Verificar el aislamiento entre dos instituciones (operador)

```bash
tests/isolation.sh --a <id-A>/<env> --b <id-B>/<env> --evidence evidencias/aislamiento
```

Comprueba, con un control positivo en cada caso:

1. el servidor de A no llega a la base de B;
2. las contraseñas y las claves de sesión son distintas;
3. una sesión de A no sirve en B;
4. A no puede leer los secretos ni los paquetes de B;
5. un dato creado en A no aparece en B.

No muestra secretos. Crea un módulo de prueba en A y lo borra al terminar. El log que deja en `evidencias/` sirve como evidencia.

## Problemas frecuentes

| Situación | Solución |
|---|---|
| **Actualizar** rechaza la versión | Debe tener 12 caracteres hexadecimales y estar publicada con `tenant-update.sh publish` para **esa** institución y entorno |
| La actualización volvió a la versión anterior | El paquete no pasó la salud. Revisa los eventos o `/var/log/attendance-update.log` en el servidor (Run Command) |
| Una institución no ve un plan nuevo | Recarga el asistente. Los planes nuevos se muestran al registrar instituciones nuevas |
| No se puede eliminar un plan | Alguna institución lo usa o lo usó: edítalo |
| El administrador de la institución ve "Tu plan … permite hasta …" | Llegó al límite: cambia su plan o archiva módulos que ya no use |
