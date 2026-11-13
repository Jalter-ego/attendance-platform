# Infraestructura Terraform / OpenTofu — P1

La infraestructura compartida y la de cada tenant tendrán estados distintos.

- `base/`: red compartida, SG para Packer/monitoreo y perfil de la futura EC2 de Prometheus.
- El módulo de las tres EC2 por tenant, sus SG y perfiles SSM se implementará en el siguiente bloque, usando los outputs de `base/`.

El bucket se administra desde `infra/bootstrap/`. Borrar un tenant no debe eliminar ni el bucket ni la red compartida.

Empieza por [las instrucciones de la base](base/README.md). El código usa HCL y el proveedor AWS; las pruebas de este bloque se ejecutan con Terraform. La verificación con el CLI de OpenTofu queda pendiente.
