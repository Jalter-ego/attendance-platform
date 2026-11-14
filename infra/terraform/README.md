# Infraestructura Terraform / OpenTofu — P1

La infraestructura compartida y la de cada tenant tendrán estados distintos.

- `base/`: red compartida, SG para Packer/monitoreo y perfil de la futura EC2 de Prometheus.
- `tenant/`: tres EC2 por cliente, sus SG, perfiles SSM y disco de datos; permite suspender/reanudar conservando los discos y consume los outputs de `base/`. Ver [las instrucciones del tenant](tenant/README.md).

El bucket se administra desde `infra/bootstrap/`. Borrar un tenant no debe eliminar ni el bucket ni la red compartida.

Empieza por [las instrucciones de la base](base/README.md). El código usa HCL y el proveedor AWS; las pruebas de este bloque se ejecutan con Terraform. La verificación con el CLI de OpenTofu queda pendiente.
