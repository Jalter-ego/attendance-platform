# Continuar validación de P6

El control center corre LOCALMENTE. Cada tenant debe crear tres EC2 en AWS. No desplegar el panel ni modificar los recursos existentes de otro integrante.

## Integración de código

Se incorporó master remoto hasta e6e0b77 (PRs 28–32): aislamiento, Pulumi de P2, manuales P3/P4 y request logging. Se conserva la implementación Pulumi del equipo, no la alternativa local de P6. El checkout activo original no se actualizó ni se reiniciaron procesos.

## Comprobado antes de integrar

- API: 82 pruebas aprobadas, 2 omitidas por plataforma; integración PostgreSQL: 23 aprobadas; frontend lint/build aprobados.
- OpenTofu: 26 comprobaciones de infraestructura aprobadas.
- En la cuenta de Sebastián se construyeron tres AMIs 0.3.0 y la base compartida en Ohio.
- Terraform y OpenTofu crearon tres EC2 cada uno y pasaron salud HTTP/API/BD.
- Reintento de creación Terraform reutilizó las mismas EC2.
- Se probaron suspensión y arranque reales, pero la validación integral de conservación de datos NO está cerrada.
- CloudFormation y Pulumi del código integrado todavía necesitan pruebas AWS desde el panel.

## Correcciones y próximo paso

1. Se corrigió la lectura temporal de associate_public_ip_address al detener EC2 mediante ignore_changes, conservando la protección del worker contra reemplazos.
2. OpenTofu necesita poder convertir la identidad del proveedor en su lockfile de ejecución; se conserva la versión, sin -upgrade.
3. Windows necesita Git Bash y jq LOCAL; el arranque añade .local/tools/jq al PATH.
4. Último fallo diagnosticado: el probe de BD usaba cat sobre boot.json multilínea y generaba JSON incompleto. Se cambió a jq -c. Esta última corrección aún necesita validación real. No presentar los ciclos completos como aprobados.
5. Primero comprobar salud con --boot y JSON válido en los tres roles. Luego repetir marcador PostgreSQL → suspender → reanudar → mismo EBS/EC2 y dato conservado.
6. Después validar creación y ciclo con CloudFormation y Pulumi del equipo. No mezclar snapshots ni estados de la implementación Pulumi alternativa anterior.

## Continuar con OTRA cuenta AWS

No reutilizar IDs de VPC, subredes, AMIs, instancias o buckets de Sebastián. No copiar .env, credenciales, passphrase Pulumi ni .local/runs entre cuentas.

1. Autenticar el perfil propio con el método autorizado por el equipo y comprobar aws sts get-caller-identity.
2. Elegir región coherente; el asistente actual ofrece Ohio/us-east-2.
3. Preparar bucket de estado con infra/bootstrap y base con infra/terraform/base. Revisar planes antes de aplicar; no importar ni reemplazar infraestructura ajena.
4. Construir AMIs con Packer en la cuenta propia o compartir/copiar imágenes explícitamente; generar catálogo nuevo. Los IDs del catálogo versionado pueden pertenecer a otra cuenta.
5. Exportar integration a .local/base.outputs.json y configurar IAC_STATE_BUCKET con el bucket propio.
6. Preparar PostgreSQL exclusivo de integración, migraciones, operador y .env privado. Ajustar AWS_PROFILE, región y rutas de ejecutables. El script start-local.ps1 usa default al crear un entorno nuevo; adaptarlo al perfil propio o preparar .env antes.
7. Para Pulumi seguir infra/pulumi/README.md del equipo; conservar backend y passphrase propios. No reutilizar el antiguo esquema stack_name del adaptador alternativo.
8. Iniciar API y worker separados y crear tenants test con identificadores nuevos desde el panel.

## Archivos y precauciones

Guías: platform/LOCAL.md, platform/DEMO-P6.md y manuales del equipo en docs/manual/.
El script tests/aws.e2e.js requiere --allow-aws; crea/modifica recursos reales y guarda evidencia local. Su ciclo completo sigue pendiente de aprobar. Las pruebas con dobles no constituyen evidencia AWS.

La instalación privada anterior de Sebastián conserva su base y configuración originales; no migrar ni reiniciar automáticamente esa instalación al bajar esta rama. Revisar compatibilidad de snapshots antes de usar trabajos pendientes.

No hay validación de procesos ni credenciales de Marcelo: se preservó su código remoto y no se accedió a sus servicios. Coordinar la actualización de sus procesos con él.
