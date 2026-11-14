# Infraestructura Terraform / OpenTofu — P1

La infraestructura compartida y la de cada tenant tendrán estados distintos.

- `base/`: red compartida, SG para Packer/monitoreo, respaldos y EC2 opcional compartida de Prometheus/Grafana. Ver [cómo habilitar monitoreo](base/README.md#habilitar-la-ec2-de-monitoreo).
- `tenant/`: tres EC2 por cliente, sus SG, perfiles SSM y disco de datos; permite suspender/reanudar conservando los discos y consume los outputs de `base/`. Ver [las instrucciones del tenant](tenant/README.md).

El bucket se administra desde `infra/bootstrap/`. Borrar un tenant no debe eliminar ni el bucket ni la red compartida.

Empieza por [las instrucciones de la base](base/README.md). El código usa HCL y el proveedor AWS; las pruebas de este bloque se ejecutan con Terraform. La verificación con el CLI de OpenTofu queda pendiente.

## Vista previa de cambios — C4

`plan_preview.py` convierte un plan guardado en una lista legible o un resumen JSON. Solo lee: no ejecuta `apply`, no crea recursos y no cambia el estado. Requiere Python 3, sin instalar dependencias.

Desde la raíz del repositorio, con el backend del tenant ya inicializado y sus variables preparadas:

```bash
terraform -chdir=infra/terraform/tenant plan -lock-timeout=5m -var-file=../../../.local/san-marcos.tfvars.json -out=../../../.local/san-marcos.tfplan
python3 infra/terraform/plan_preview.py --directory infra/terraform/tenant --plan .local/san-marcos.tfplan
```

Para revisar una eliminación, prepara otro plan, sin destruir nada:

```bash
terraform -chdir=infra/terraform/tenant plan -destroy -lock-timeout=5m -var-file=../../../.local/san-marcos.tfvars.json -out=../../../.local/san-marcos-destroy.tfplan
python3 infra/terraform/plan_preview.py --directory infra/terraform/tenant --plan .local/san-marcos-destroy.tfplan
```

La lista distingue creación, modificación, eliminación, reemplazo y lectura. Un reemplazo cuenta también como una creación y una eliminación. Destaca eliminación de volúmenes EBS/discos raíz, desacoplamiento del disco, parada y cambios de tamaño de EC2 que pueden interrumpir el servicio. Un cambio de permisos IAM no se presenta como reemplazo de servidores.

Muestra tamaños, AMIs y estados de EC2; omite políticas IAM, cloud-init, variables y valores de outputs. Respeta las marcas de sensibilidad incluso en los campos permitidos. El resumen ayuda a revisar recursos y discos; los detalles de una política IAM se revisan también en su código. No calcula costos ni sustituye la revisión del plan original.

Para que P2 lo pueda integrar después, sin modificar ahora la API ni el frontend:

```bash
python3 infra/terraform/plan_preview.py --directory infra/terraform/tenant --plan .local/san-marcos.tfplan --output json > .local/san-marcos.preview.json
```

El JSON incluye `summary_version`, totales, `changes`, `has_deletions`, `data_volumes_deleted`, nombres de outputs modificados y avisos. `complete`/`applyable` conservan lo reportado por el motor (`null` si no lo informa); un plan fallido o incompleto se señala. Código de salida `0` significa que se pudo leer y resumir, no que esté aprobado para aplicar; `1` indica error o plan fallido; `2`, argumentos incorrectos.

También acepta `--json-file <archivo>` si P2 ya obtuvo un plan con `show -json`, y `--engine tofu` para leer un plan binario de OpenTofu cuando esté instalado. Esta opción no da por completada C6: falta probar ese CLI con el módulo.

Usa un plan recién generado sobre el estado correcto. Leer un plan no comprueba si quedó obsoleto por cambios posteriores. Los planes y el JSON completo de Terraform pueden contener secretos; mantenlos en `.local/` y fuera de Git. La herramienta captura `show -json` en memoria y evita copiar sus valores privados o errores sin filtrar al resumen. [HashiCorp documenta que `show -json` expone los valores sensibles](https://developer.hashicorp.com/terraform/cli/commands/show).

Pruebas locales, sin AWS ni proveedores:

```bash
python3 -m unittest discover -s infra/terraform/tests -v
```
