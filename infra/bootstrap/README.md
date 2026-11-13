# Bootstrap del estado compartido — P1

Este directorio crea únicamente un bucket S3 para los estados del proyecto. No crea EC2, red ni aplicaciones. Se utiliza una vez por proyecto, por P1; los demás participantes consumirán el bucket con sus propios permisos.

El bucket tendrá cifrado AES256, versionado, bloqueo de acceso público, propiedad de objetos del dueño del bucket y política que rechaza transporte sin HTTPS. `prevent_destroy` y `force_destroy=false` protegen su eliminación accidental mediante este Terraform.

El bloqueo de estado se habilita en **cada backend consumidor**, con `use_lockfile=true`; crear el bucket no activa ese bloqueo por sí solo. Los permisos de los participantes y la prueba de dos operaciones concurrentes siguen pendientes.

## 1. Configurar y revisar

Desde la raíz del repositorio, con Terraform >= 1.10 y AWS CLI disponibles:

```bash
export AWS_PROFILE=attendance-terraform
aws sts get-caller-identity

mkdir -p .local
cp infra/bootstrap/terraform.tfvars.example .local/bootstrap.tfvars
```

`attendance-terraform` es el nombre del perfil que ya usábamos; reemplázalo si usas otra identidad. Revisa `.local/bootstrap.tfvars`, especialmente región y proyecto. Las credenciales se resuelven desde el perfil AWS, nunca desde los archivos `.tf` o `backend.hcl`.

El bucket se llamará `<project_name>-tfstate-<id-de-cuenta>`. Usa un nombre de proyecto propio y conserva la región elegida. Si ese bucket ya existe y pertenece a otra configuración, no lo reutilices sin revisar su administración y estado.

## 2. Crear el bucket

Solo para la primera creación, antes de copiar `backend.tf`: Terraform usa temporalmente su estado local en `infra/bootstrap/`.

```bash
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap fmt -check
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap plan -var-file=../../.local/bootstrap.tfvars -out=../../.local/bootstrap.tfplan
terraform -chdir=infra/bootstrap apply ../../.local/bootstrap.tfplan
terraform -chdir=infra/bootstrap output
```

Revisa el plan antes de aplicar. Mantén el estado local hasta completar la migración siguiente. Este estado y el plan están excluidos de Git; el lockfile de proveedores sí se sube.

## 3. Compartir también el estado del bootstrap

Después de crear el bucket:

```bash
cp infra/bootstrap/backend.tf.example infra/bootstrap/backend.tf
cp infra/bootstrap/bootstrap.backend.hcl.example .local/bootstrap.backend.hcl
```

Edita `.local/bootstrap.backend.hcl`: usa el nombre real y la región de `terraform output`. Mantén la clave `platform/bootstrap/terraform.tfstate`, `encrypt=true` y `use_lockfile=true`. Ambos archivos locales están excluidos de Git para permitir la primera creación sin un bucket preexistente.

```bash
terraform -chdir=infra/bootstrap init -migrate-state -backend-config=../../.local/bootstrap.backend.hcl
terraform -chdir=infra/bootstrap plan -var-file=../../.local/bootstrap.tfvars
```

Acepta la copia del estado cuando Terraform lo solicite. El plan final debería mostrar que no hay cambios. No vuelvas a trabajar con una copia local independiente del estado.

En otro clon que necesite administrar **este bootstrap**, se copian los mismos ejemplos y se configura el bucket existente; se ejecuta `init -backend-config=...` (sin `-migrate-state`, porque ese clon no tiene estado que migrar). No ejecutar primero `apply` en un clon nuevo: intentaría crear de nuevo un bucket ya administrado.

## 4. Siguiente bloque

Con el bucket creado y su estado migrado, P1 prepara permisos IAM de acceso al estado para los participantes y la capa de red compartida. Sus estados tendrán otras claves según [las convenciones](../../docs/contratos-integracion.md). No mezclar el estado del bucket con el de las EC2.

## Validación sin crear recursos

```bash
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test
```

Las pruebas usan un proveedor AWS simulado y no crean recursos ni comprueban la cuenta real. Terraform necesita descargar el proveedor al inicializarse si todavía no está disponible localmente. No activar el backend S3 para estas pruebas.

Referencias: [backend S3 y sus permisos](https://developer.hashicorp.com/terraform/language/backend/s3), [recomendaciones de AWS para el backend](https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/backend.html).
