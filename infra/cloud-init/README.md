# Primer arranque (cloud-init) — P3

Cada VM de un tenant sale de una AMI de Packer que **ya tiene todo instalado**. En el primer
arranque solo falta lo propio del tenant: a qué BD conectarse, sus secretos, su disco de datos.

```
user_data (user-data.yaml.tftpl, lo renderiza el motor IaC)
  └─ cloud-init
       ├─ escribe /etc/attendance/tenant.json   (identidad, sin secretos)
       └─ runcmd: /usr/local/sbin/attendance-boot   (horneado en la AMI)
            ├─ lee secretos de SSM  /tenants/<id>/<env>/*   (solo backend y db)
            ├─ ansible-playbook -c local /opt/attendance/ansible/boot.yml
            │    db       → monta el EBS, PostgreSQL solo desde la VPC, usuario y base del tenant
            │    backend  → backend.env, espera la BD, migraciones, admin inicial, arranca la API
            │    frontend → nginx apunta al backend privado del tenant
            └─ señal de listo: /var/lib/attendance/boot.json  {"status":"ready"|"failed", ...}
```

Log completo en la VM: `/var/log/attendance-boot.log` (y `/var/log/cloud-init-output.log`).
Reintentar a mano: `sudo attendance-boot` (es idempotente).

## Contrato con el motor IaC (P1 / P2)

Renderizar una vez por VM:

```hcl
user_data = templatefile("${path.module}/../../cloud-init/user-data.yaml.tftpl", {
  role             = "backend"                       # frontend | backend | db
  tenant_id        = var.tenant_id                   # 3-40: ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$
  env              = var.env                         # test | prod
  plan             = var.plan
  region           = var.region
  ssm_prefix       = "/tenants/${var.tenant_id}/${var.env}"
  vpc_cidr         = data.aws_vpc.base.cidr_block    # pg_hba: solo se aceptan conexiones de aquí
  db_host          = aws_instance.db.private_ip      # lo usa backend ("" en los otros)
  backend_host     = aws_instance.backend.private_ip # lo usa frontend ("" en los otros)
  db_volume_id     = aws_ebs_volume.db.id            # lo usa db ("" = disco raíz, solo pruebas)
  institution_name = var.name
  timezone         = var.timezone                    # p. ej. America/La_Paz
  admin_email      = var.contact_email
  limits           = var.limits                      # mapa: max_students, max_teachers, ...
})
```

Orden sin ciclos: `aws_ebs_volume.db` → `db` → `backend` (usa la IP de db) → `frontend` (usa la IP de backend).
El EBS se adjunta con `aws_volume_attachment` (`device_name = "/dev/sdf"`); boot espera hasta 5 min a que aparezca.

### Secretos en SSM (SecureString, los genera la plataforma/worker, nunca el IaC)

| Parámetro | Lo lee | Requisito |
|---|---|---|
| `/tenants/<id>/<env>/db_password` | db, backend | ≥ 16 caracteres, **solo letras y números** |
| `/tenants/<id>/<env>/jwt_secret` | backend | ≥ 32 caracteres, solo letras y números |
| `/tenants/<id>/<env>/admin_password` | backend | 12-72 caracteres, solo letras y números (opcional) |

"Solo letras y números" porque los valores terminan en `backend.env` (systemd + shell).

### Perfil IAM de cada instancia (P1)

```json
{ "Effect": "Allow", "Action": ["ssm:GetParametersByPath", "ssm:GetParameters"],
  "Resource": "arn:aws:ssm:<region>:<cuenta>:parameter/tenants/<id>/<env>/*" }
```
+ `kms:Decrypt` sobre la llave de SSM (la por defecto `alias/aws/ssm` no necesita permiso extra).
Una instancia **no puede** leer los secretos de otro tenant → prueba de aislamiento nº 4.

### Puertos que deben abrir los SG (P1)

| Origen → destino | Puerto |
|---|---|
| Internet → frontend | 80 |
| frontend → backend | 5000 |
| backend → db | 5432 |
| SG de monitoreo → todas | 9100, 9256, 8889, 19999 (+ 5000 en backend para `/metrics`) |
