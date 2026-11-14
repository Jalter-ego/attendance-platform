# Infraestructura Terraform / OpenTofu — P1

La infraestructura compartida y la de cada tenant tendrán estados distintos.

- `base/`: red compartida, SG para Packer/monitoreo, respaldos y EC2 opcional compartida de Prometheus/Grafana. Ver [cómo habilitar monitoreo](base/README.md#habilitar-la-ec2-de-monitoreo).
- `tenant/`: tres EC2 por cliente, sus SG, perfiles SSM y disco de datos; permite suspender/reanudar conservando los discos y consume los outputs de `base/`. Ver [las instrucciones del tenant](tenant/README.md).

El bucket se administra desde `infra/bootstrap/`. Borrar un tenant no debe eliminar ni el bucket ni la red compartida.

Empieza por [las instrucciones de la base](base/README.md). Ambos motores usan los mismos módulos HCL y el mismo proveedor AWS. La compatibilidad local está verificada; el despliegue real con OpenTofu y la prueba de bloqueo concurrente siguen pendientes.

## Comprobar Terraform y OpenTofu — C6

Desde la raíz del repositorio, con Python 3 y los CLI instalados:

```bash
python3 infra/terraform/check_engines.py --engine terraform
python3 infra/terraform/check_engines.py --engine tofu
```

El verificador crea copias en `.local/c6-<motor>-...`, excluye el backend, los estados y las variables locales, usa credenciales ficticias y ejecuta `fmt`, `init -backend=false`, `validate` y las pruebas con AWS simulado. No aplica cambios a AWS ni migra el estado. Deja `report.json` y logs por módulo en la carpeta que indica al comenzar. Si necesita descargar el proveedor, requiere Internet.

En el equipo del responsable se dejó OpenTofu portátil en `.local/bin/tofu`, fuera de Git. Para usarlo y reutilizar el proveedor que Terraform ya descargó:

```bash
python3 infra/terraform/check_engines.py --engine tofu --binary .local/bin/tofu --plugin-dir infra/terraform/base/.terraform/providers
```

En otros equipos, instalar OpenTofu siguiendo [sus instrucciones oficiales](https://opentofu.org/docs/intro/install/standalone/); el ejecutable local no se comparte por Git. `--plugin-dir` es opcional y debe apuntar a un mirror/caché que contenga la versión fijada en los lockfiles.

Verificado el 14/11/2026 en Linux amd64: **Terraform 1.16.6 y OpenTofu 1.13.9**, ambos con **AWS 6.69.1**. Cada motor superó **26 pruebas**: 2 de bootstrap, 11 de base y 13 de tenant. Cubren aislamiento, permisos, almacenamiento y suspensión/reanudación conservando IDs de EC2/EBS. Son simulaciones; no comprueban arranque de AMIs, datos reales ni bloqueo S3 entre dos participantes.

La fuente del proveedor se declara completa como `registry.terraform.io/hashicorp/aws` para conservar su identidad con ambos motores. El verificador comprueba que `init` conserve versión y hashes del lockfile; solo permite cambiar su comentario de cabecera. No se actualiza el proveedor ni se modifican los lockfiles del checkout.

Las suites originales están escritas para Terraform. En las copias de OpenTofu el verificador elimina `override_during`, aporta un ARN ficticio válido y evita sobrescribir IDs de subred ya configurados. También pasa las referencias entre pruebas por una variable de prueba: cada paso compara los IDs con el anterior, conservando la comprobación del ciclo completo. Mantiene las condiciones y valores esperados; los archivos originales no cambian. Ver [las pruebas nativas de OpenTofu](https://opentofu.org/docs/cli/commands/test/).

Para P2, al ejecutar **un tenant nuevo** con OpenTofu:

- Usar un directorio y backend propios del tenant/entorno, con `engine="tofu"`, `use_lockfile=true` y la ruta absoluta de `cloud_init_template_path` cuando sea necesaria.
- El worker puede copiar los `.tf` y el lockfile sin las suites. Si conserva `tests/`, añadir `-test-directory=.c6-no-tests` a `tofu init` y `-no-tests` a `tofu validate`, porque esas suites contienen sintaxis específica de Terraform. Para probarlas, usar el verificador anterior.
- Ejecutar `plan`, `show`, `apply` y `output` con el mismo motor y su propia configuración; no mezclar planes binarios entre motores.
- Mantener la base compartida y las instalaciones existentes con su motor actual. Este trabajo no migra el estado de Terraform a OpenTofu.

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

También acepta `--json-file <archivo>` si P2 ya obtuvo un plan con `show -json`, y `--engine tofu` para leer un plan binario de OpenTofu cuando el ejecutable `tofu` esté disponible en `PATH`.

Usa un plan recién generado sobre el estado correcto. Leer un plan no comprueba si quedó obsoleto por cambios posteriores. Los planes y el JSON completo de Terraform pueden contener secretos; mantenlos en `.local/` y fuera de Git. La herramienta captura `show -json` en memoria y evita copiar sus valores privados o errores sin filtrar al resumen. [HashiCorp documenta que `show -json` expone los valores sensibles](https://developer.hashicorp.com/terraform/cli/commands/show).

Pruebas locales, sin AWS ni proveedores:

```bash
python3 -m unittest discover -s infra/terraform/tests -v
```
