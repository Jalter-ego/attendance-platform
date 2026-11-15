# Motores IaC: estado y comparación técnica — P2 (A6 con P1, D6)

La plataforma crea la infraestructura de cada tenant con cualquiera de cuatro motores. Los cuatro reciben la misma entrada (`platform_api/src/engines/tenant-input.js`), crean los mismos recursos (3 EC2 desde las AMIs de Packer, 3 SG, perfiles IAM y un EBS cifrado para PostgreSQL) y usan el mismo cloud-init. El panel no conoce el motor: habla con un `EngineAdapter` común (`src/engines/adapter.js`).

| Motor | Código de infraestructura | Adaptador |
| --- | --- | --- |
| Terraform | `infra/terraform/tenant` (HCL) | `src/engines/terraform.js` (crear) y `src/worker/services/terraform-adapter.js` (ciclo de vida) |
| OpenTofu | El mismo módulo HCL | Los mismos, con `engine = "tofu"` |
| CloudFormation | `infra/cloudformation/tenant.yaml` (YAML) | `src/engines/cloudformation.js` (SDK de AWS) |
| Pulumi | `infra/pulumi/tenant` (JavaScript) | `src/engines/pulumi.js` (CLI de Pulumi) |

Terraform/OpenTofu es el motor principal. CloudFormation y Pulumi son la segunda implementación que pide la sección 4 del enunciado.

## 1. Cómo se almacena y protege el estado (A6)

El "estado" es el registro que guarda el motor de qué recursos creó para cada tenant. Si se pierde o se corrompe, el motor ya no sabe qué administra. Por eso cada motor lo guarda fuera de la máquina del worker y con un estado independiente por tenant y entorno.

### Bucket de estado compartido (P1)

Lo crea `infra/bootstrap` una sola vez por cuenta: `attendance-platform-tfstate-<cuenta>`, en `us-east-2`. Lo usan Terraform, OpenTofu y Pulumi.

| Protección | Cómo |
| --- | --- |
| Cifrado en reposo | SSE-S3 (AES256) por defecto |
| Cifrado en tránsito | La política del bucket rechaza cualquier petición sin HTTPS |
| Recuperación | Versionado activado: un estado dañado se recupera con la versión anterior |
| Acceso | Bloqueo de acceso público y propiedad de objetos del dueño del bucket |
| Borrado accidental | `prevent_destroy` y `force_destroy = false` en el propio Terraform |
| Organización | Una clave por tenant: nadie comparte estado con otro cliente |

### Por motor

| | Terraform / OpenTofu | CloudFormation | Pulumi |
| --- | --- | --- | --- |
| **Dónde** | `s3://<bucket>/tenants/<id>/<env>/terraform.tfstate` | En AWS: el propio stack `attendance-platform-<id>-<env>`. No hay archivo | `s3://<bucket>/pulumi/`, stack `organization/attendance-tenant/<id>-<env>` |
| **Bloqueo** | `use_lockfile = true`: archivo `.tflock` en el mismo bucket | AWS no admite dos operaciones a la vez sobre un stack | Bloqueo del stack en el backend en cada `up`, `destroy` o `unprotect` |
| **Cifrado** | `encrypt = true` en el backend, más el del bucket | Lo gestiona AWS | El del bucket, más el proveedor de secretos del stack (`PULUMI_SECRETS_PROVIDER`: frase en el `.env` del worker o `awskms://`) |
| **Configuración por tenant** | `tenant.backend.hcl` y `tenant.tfvars.json`, generados en `.local/runs/<id>/<env>/`, nunca en el repo | Parámetros del stack | `Pulumi.<stack>.yaml` en `.local/runs/<id>/<env>/pulumi/` |
| **Fijado** | La clave queda congelada en la operación al encolar: un reintento no puede cambiar de estado (`IAC_STATE_CHANGED`) | Nombre y ARN del stack en el despliegue | URL del backend y nombre del stack en el despliegue |

### Reglas comunes a los cuatro motores

- **Sin secretos en el estado.** Las contraseñas (`db_password`, `jwt_secret`, `admin_password`) se crean en SSM Parameter Store (`/tenants/<id>/<env>/`) antes de llamar al motor. El motor solo recibe nombres, IDs y tamaños; cada VM lee sus secretos al arrancar, con un rol IAM limitado a su prefijo.
- **Una operación por tenant.** La cola de la plataforma no permite dos operaciones activas sobre el mismo tenant (índice único en la base). El bloqueo del motor es la segunda barrera.
- **El disco de datos está protegido.** Un cambio que eliminaría o reemplazaría el EBS de PostgreSQL se rechaza antes de aplicarse. Solo una eliminación con vista previa confirmada lo borra.
- **Logs sin secretos.** Todo lo que sale de los motores pasa por `redact`, y la frase de Pulumi se pasa solo por variable de entorno.
- **Credenciales AWS.** Las del operador, desde su perfil (`AWS_PROFILE`), nunca en archivos del repositorio.

## 2. Comparación técnica (D6)

### Resumen

| Criterio | Terraform / OpenTofu | CloudFormation | Pulumi |
| --- | --- | --- | --- |
| **Lenguaje** | HCL, declarativo | YAML/JSON, declarativo | JavaScript (o TS, Python, Go), programa que declara recursos |
| **Dónde vive el estado** | Lo gestionamos nosotros (S3) | Lo gestiona AWS | Lo gestionamos nosotros (S3) o Pulumi Cloud |
| **Vista previa** | `plan` guardado en archivo; se aplica exactamente ese plan | Change set: AWS calcula los cambios y se ejecuta o se descarta | `preview --json`; luego `up` |
| **Idempotencia** | Un `plan` sin cambios no hace nada; un reintento retoma desde el estado | Change set vacío se descarta; un `ROLLBACK_COMPLETE` se elimina y se crea de nuevo | `preview` sin cambios: no se ejecuta `up` |
| **Rollback ante fallo** | No hay rollback automático: queda lo creado y el reintento completa lo pendiente | **Automático**: AWS revierte la creación o la actualización | No hay rollback automático, como Terraform |
| **Suspender y reanudar** | Declarativo, con `aws_ec2_instance_state` | **No es declarativo**: el adaptador llama a `StopInstances` y `StartInstances` (D5) | Declarativo, con `InstanceState` |
| **Proteger el disco de datos** | El adaptador revisa el plan y rechaza reemplazos del EBS | El adaptador revisa el change set y lo descarta | `protect: true` en el recurso, y el adaptador revisa el preview |
| **Eliminar** | `plan -destroy`, vista previa y confirmación | `DeleteStack`; la vista previa lista los recursos del stack | Huella SHA-256 de `stack export`, `state unprotect` y `destroy` |
| **Cancelar a mitad** | Se espera a que termine el `apply` en curso (60 s de gracia al apagar el worker) | Deja de seguirse, pero **AWS continúa**; el reintento espera | Se espera al `up` o `destroy` en curso (60 s de gracia al apagar el worker) |
| **Multinube** | Sí | Solo AWS | Sí |
| **Herramienta extra en el worker** | Binario `terraform` o `tofu` | Ninguna: SDK de AWS en Node | CLI `pulumi` y `node_modules` del programa |
| **Licencia** | Terraform: BUSL 1.1. OpenTofu: MPL 2.0 (bifurcación abierta) | Servicio de AWS | Apache 2.0 |
| **Curva de aprendizaje** | Media: HCL es propio pero simple, mucha documentación | Media-alta: plantillas largas, funciones `!Sub`/`!GetAtt`, errores poco claros | Baja para quien ya programa en JS; alta para depurar el modelo de `Output` asíncrono |

### Lo que vimos al implementarlos

**Terraform / OpenTofu**
- El `plan` guardado en archivo es la mejor vista previa de los tres: lo que se revisa es exactamente lo que se aplica.
- OpenTofu usa el mismo módulo sin cambios. Solo cambia el binario y el registro de proveedores en el lockfile.
- Hay que administrar el estado: bucket, bloqueo, cifrado y una clave por tenant.

**CloudFormation**
- No necesita bucket de estado ni bloqueo: AWS lo resuelve.
- El rollback automático deja la cuenta limpia ante un fallo, pero el stack queda en `ROLLBACK_COMPLETE` y hay que eliminarlo antes de reintentar.
- No puede detener instancias de forma declarativa: suspender y reanudar se hacen fuera de la plantilla, con la API de EC2. Es la diferencia más visible con los otros dos (D5).
- Cancelar desde la plataforma no detiene la operación en AWS.

**Pulumi**
- La infraestructura es código JavaScript, el mismo lenguaje del backend: se reutilizan validaciones y se prueba con mocks, sin AWS.
- `protect: true` protege el disco en el propio motor, no solo en el adaptador.
- Los valores son `Output` asíncronos: es la parte más difícil de aprender.
- Necesita el CLI, las dependencias del programa y una frase o clave KMS para cifrar la configuración del stack.

### Operaciones disponibles en la plataforma

| Operación | Terraform / OpenTofu | CloudFormation | Pulumi |
| --- | --- | --- | --- |
| Crear | ✅ | ✅ | ✅ |
| Suspender / reanudar | ✅ | ✅ | ✅ |
| Vista previa de eliminación y eliminar | ✅ | ✅ | ✅ |
| Cambiar de plan | ✅ | — | — |
| Actualizar la app | ✅ | — | — |

El plan del proyecto exige el ciclo completo con el motor principal y al menos el plan Básico con los otros. Cambiar de plan y actualizar la app se limitan a Terraform/OpenTofu (`src/engines/lifecycle-capabilities.js`). La actualización de la app no depende del motor (localiza las VMs por etiquetas), así que extenderla a CloudFormation y Pulumi es un cambio pequeño pendiente.

### Por qué Terraform/OpenTofu es el principal

1. Vista previa exacta con el plan guardado: la plataforma muestra al usuario lo que se va a aplicar, incluida la pérdida de datos.
2. Suspender y reanudar declarativos, sin llamadas aparte a EC2.
3. Mismo código para Terraform y OpenTofu: si la licencia de Terraform es un problema, se cambia de binario.
4. Es la herramienta que conoce todo el equipo y la que usan la red base y el bootstrap.

## 3. Cómo se prueba cada motor

```bash
cd platform/platform_api
pnpm test:engines          # EngineAdapter y los cuatro motores
pnpm test:cloudformation   # CloudFormation con un SDK simulado
pnpm test:pulumi           # Pulumi con un CLI simulado
node --test tests/terraform-adapter.test.js
pnpm --dir ../../infra/pulumi/tenant test   # programa Pulumi con mocks
```

Ninguna de estas pruebas crea recursos en AWS. Para la prueba real se configura `PLATFORM_DEPLOY_MODE=integration` y se crea un tenant desde el panel con cada motor (ver `platform/LOCAL.md`).

## 4. Prueba real en AWS desde el panel

**15/11/2026**, cuenta propia de P2 en `us-east-2`. Preparación: bucket de estado con `infra/bootstrap`, red base con `infra/terraform/base` (sin EC2 de monitoreo) y AMIs **0.3.0** (frontend, backend y db) construidas con Packer desde `master`. Plataforma local en modo `integration`, con su propia base PostgreSQL. Un tenant por motor, plan Básico, entorno `test`, creado y operado solo desde el panel.

| Operación | Terraform (`prueba-tf`) | CloudFormation (`prueba-cfn`) | Pulumi (`prueba-pulumi`) |
| --- | --- | --- | --- |
| Crear (hasta la salud correcta) | ✅ 4 min 59 s | ✅ 5 min 00 s | ✅ 4 min 39 s |
| Suspender | ✅ 1 min 31 s | ✅ 34 s | ✅ 1 min 13 s |
| Reanudar | ✅ 1 min 44 s | ✅ 21 s | ✅ 1 min 17 s |
| Vista previa de eliminación | ✅ 32 s | ✅ 1 s | ✅ 3 s |
| Eliminar | ✅ 2 min 39 s | ✅ 1 min 56 s | ✅ 3 min 34 s |

Comprobado en AWS:

- **Crear:** 3 EC2 `t3.micro`, frontend con IP pública y backend/db sin ella. `/` y `/core/api/v1/health` respondieron 200, con frontend, backend y base sanos. El despliegue registró las versiones del motor, del proveedor y de las AMIs.
- **Suspender y reanudar:** las mismas tres instancias (mismos IDs) y el mismo EBS de datos antes y después; no se recreó nada. La IP pública del frontend cambió al reanudar (AWS la libera al detener) y la plataforma guardó la URL nueva antes de marcar el tenant como listo.
- **Aislamiento IAM:** cada tenant recibe tres roles con perfil de instancia (`<prefijo>-frontend|backend|db`), no usuarios IAM.
- **Estado:** Terraform escribió `tenants/<id>/test/terraform.tfstate` y Pulumi `pulumi/.pulumi/stacks/attendance-tenant/<id>-test.json` (con su historial y copias), ambos en el bucket de estado. CloudFormation no escribió nada en el bucket.
- **Eliminar:** no quedaron EC2, volúmenes, SG, roles ni stacks del tenant. Se conservan la red base y el bucket de estado.

Pendiente: OpenTofu en AWS real (no estaba instalado en el equipo de la prueba; usa el mismo módulo que Terraform) y comprobar que un dato escrito en la aplicación sobrevive a suspender y reanudar.
