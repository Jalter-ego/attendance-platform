# Infraestructura, estado y costos — P1

## Qué administra P1

- `infra/bootstrap`: bucket privado para el estado compartido.
- `infra/terraform/base`: VPC, subredes, rutas, endpoints, monitoreo y presupuesto opcional.
- `infra/terraform/tenant`: tres EC2, EBS de datos, SG y roles IAM por institución.
- [Arquitectura y flujo](../arquitectura-p1.md), con el contrato de estado de los cuatro motores.

La base compartida se prepara una vez. El worker usa sus outputs y las AMIs de P3;
no crea una VPC nueva por institución. Conserva `.local/base.outputs.json` actualizado
después de aplicar cambios a la base. Los `.env`, `.tfvars`, planes y estados son locales.

## Crear una institución desde la plataforma

1. API y worker deben usar la misma base en modo `integration`, perfil AWS y configuración.
2. En **Instituciones → Registrar institución**, completa identidad, contacto, plan y motor.
3. Activa **Crear la infraestructura al confirmar**; también se puede crear un borrador y
   utilizar **Crear infraestructura** desde su detalle.
4. Observa **Operaciones**. `En cola` significa que el worker aún no tomó el trabajo.
   `Apply complete` confirma recursos; `Disponible` se muestra después de los health checks.
5. Utiliza la URL publicada en **Accesos**. El correo inicial es el contacto registrado;
   la contraseña se consulta en SSM en `/tenants/<id>/<env>/admin_password`.

El administrador inicial de Attendance y las cuentas de acceso a la plataforma son
cuentas independientes. Para consultar el secreto, usa el perfil autorizado y mantén
el valor fuera de capturas, eventos y documentos de entrega.

## Suspender y reanudar

En el detalle, **Suspender** detiene las tres EC2 mediante el motor, conservando su
identidad y el disco EBS. Durante la suspensión las URLs se ocultan. **Reanudar**
arranca las mismas instancias, obtiene la IP pública vigente y comprueba la salud
antes de marcar la institución disponible. La URL anterior puede cambiar.

Suspender no equivale a eliminar: EBS, snapshots, S3 y endpoints compartidos pueden
seguir generando cargos. La EC2 de monitoreo pertenece a la base compartida y no se
incluye en una suspensión de tenant. Al detener monitoreo, Grafana y Prometheus
quedan temporalmente inaccesibles; las instituciones pueden seguir funcionando.

## Eliminar

**Eliminar → Ver vista previa** muestra recursos y datos afectados. Comprueba la
institución y confirma. Se eliminan sus EC2 y el EBS de datos; el historial se conserva.
La VPC, el bucket de estado, monitoreo y los recursos compartidos permanecen.
Los secretos SSM y los respaldos conservados tienen su política de retención independiente.

## Control de costos de pruebas — A7

Ejecuta desde la raíz del repositorio, con Node >= 22.13. La API y el worker deben estar
iniciados. El script utiliza una cuenta `platform_admin` mediante
`PLATFORM_ADMIN_EMAIL/PASSWORD` o los `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` del `.env`.
`PLATFORM_API_URL` permite indicar otro puerto local (predeterminado: `5001/api/v1`).

```bash
# Listado; no encola operaciones de infraestructura.
node --env-file=platform/platform_api/.env scripts/test-costs.mjs list

# Revisión de candidatos, sin ejecutar la suspensión.
node --env-file=platform/platform_api/.env scripts/test-costs.mjs suspend

# Suspender solo una institución test disponible.
node --env-file=platform/platform_api/.env scripts/test-costs.mjs suspend --tenant colegio-a --execute

# Revisar una eliminación y luego ejecutarla con confirmación explícita.
node --env-file=platform/platform_api/.env scripts/test-costs.mjs destroy --tenant colegio-a
node --env-file=platform/platform_api/.env scripts/test-costs.mjs destroy --tenant colegio-a --execute --confirm-delete colegio-a/test
```

Solo admite instituciones `test`; excluye `prod`, el identificador compartido `platform`
y las ya eliminadas. Comprueba nuevamente identidad y trabajos pendientes antes de
actuar. La eliminación exige seleccionar un tenant, una vista previa aprobada por el
worker y confirmación. No ejecuta `terminate-instances` directamente: usa el motor
de la institución y conserva la coherencia del estado y de la plataforma.

`suspend --execute` sin `--tenant` suspende todas las instituciones test disponibles
de esta plataforma; primero revisa sus candidatos con la ejecución sin `--execute`.

## Presupuesto y cuota — A2

El presupuesto es de la cuenta AWS, no de un cliente. En `.local/base.tfvars` se habilita:

```hcl
monthly_budget = {
  amount_usd = 10
  email      = "responsable@example.com"
}
```

`costs.tf` envía avisos cuando el gasto real supera el 80 % y el 100 %. No detiene
automáticamente recursos ni impone un límite de facturación. El responsable recibe
el aviso para revisar los recursos de prueba. Todos los operadores de la base deben
conservar el mismo bloque; quitarlo planifica eliminar el presupuesto administrado.
El correo real se configura en las variables locales y no en el código compartido.

La cuota regional puede consultarse sin modificar AWS:

```bash
aws --profile attendance-terraform --region us-east-2 service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A
```

La consulta de P1 del 15/11/2026 confirmó 16 vCPU Standard On-Demand en Ohio. Los tamaños
t3 que utiliza el proyecto requieren 2 vCPU por instancia: una institución de tres
EC2 utiliza 6 vCPU. También cuentan otras instancias Standard de la misma región.

## Secretos antes del commit — A1

```bash
python3 scripts/setup-secrets.py
```

Instala Gitleaks desde su publicación oficial, comprueba el SHA256 y lo guarda en
`.local/tools/`. Activa `core.hooksPath=.githooks` solo en ese clon. Cada integrante
debe ejecutarlo. El hook examina lo preparado para commit y redacta los hallazgos.
Dos tokens ficticios de las fixtures de actualización tienen una excepción explícita
en sus líneas; el resto de los archivos sigue siendo analizado.

## Estado, bloqueo y recuperación — A3 / C7

El estado vincula el código con los IDs de los recursos. Cada tenant utiliza su propia
clave S3, y cada operación su contexto de ejecución. Terraform/OpenTofu conservan
`use_lockfile=true` y esperan el bloqueo; no se desactiva con `-lock=false`.

Para una prueba reproducible del bloqueo real, sin crear EC2 ni utilizar claves de
instalaciones existentes:

```bash
python3 scripts/verify-state-lock.py --bucket BUCKET_COMPARTIDO --region us-east-2 --profile attendance-terraform --execute
```

La herramienta crea un estado aislado en `platform/evidence/p1-lock/`, mantiene un
apply breve y comprueba que otro proceso recibe el conflicto de bloqueo. Después
repite el apply, verifica el mismo ID y `No changes`, y destruye el recurso local de
prueba `terraform_data`. Solo quedan las versiones de ese estado como evidencia en S3.
Esto prueba el backend y el bloqueo; la conservación de datos de Attendance se valida
con el ciclo real de EC2/EBS y PostgreSQL descrito en las evidencias de P1.

Ante una operación fallida:

1. Conserva tenant, backend, clave, AMIs, copia del plan y secretos.
2. Revisa los eventos y corrige el prerrequisito fallido.
3. Pulsa **Reintentar** sobre la operación anterior. El motor reconcilia su mismo estado.
4. Si existe un lock, comprueba si hay otro proceso activo y espera. Un bloqueo huérfano
   requiere revisar al dueño antes de una recuperación manual; no se elimina por rutina.

La base admite OpenTofu con los mismos módulos. Cada despliegue conserva el motor con
el que nació; cambiar el selector no migra una instalación existente entre motores.
