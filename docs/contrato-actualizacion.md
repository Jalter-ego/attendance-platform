# Contrato de actualización de la app (E2 · RF-15) — P4 ↔ P6

Cómo se actualiza el frontend o el backend de un tenant **sin recrear sus EC2**: mismo ID de instancia, mismo disco, mismos datos. Complementa la sección "Actualización de la app sin recrear infraestructura" de `docs/contratos-integracion.md` (permisos de P1, ya aplicados).

## 1. Flujo

```
build-release.sh (Linux)            tenant-update.sh publish           tenant-update.sh apply
  git ref → compila → paquete  ──►  sube a S3 del tenant      ──►  Run Command en la EC2
  <comp>-<sha12>.tar.gz              releases/<comp>-<sha12>.*        descarga · verifica · extrae
  <comp>-<sha12>.tar.gz.sha256                                        ansible-playbook update.yml
                                                                      (migra · cambia enlace · health
                                                                       · vuelve atrás si falla)
                                                                      → JSON en la última línea
```

- **P4** entrega `build-release.sh`, `tenant-update.sh` y el playbook `update.yml` (va **dentro** del paquete, así funciona en las VMs que ya existen con la AMI 0.2.2, sin rehornear).
- **P6** (worker) arma o reutiliza el paquete, lo publica con sus credenciales en el prefijo del tenant y lanza `apply`. Guarda versión y desenlace.
- Las EC2 solo **leen** su propio prefijo (`tenants/<id>/<env>/releases/`). Backend y BD no tienen Internet: el paquete trae todo lo necesario.

## 2. Paquete

**Nombre:** `<componente>-<sha12>.tar.gz` y, al lado, `<componente>-<sha12>.tar.gz.sha256` (formato `sha256sum`).
`componente` ∈ `backend | frontend`; `sha12` = primeros 12 caracteres del commit de la app.

**Ubicación en S3:** `s3://<bucket de respaldos>/tenants/<tenant_id>/<env>/releases/<archivo>` (es `outputs.releases.prefix` del módulo de tenant). Sin etiqueta `retention-days`: los paquetes no los borra el lifecycle de los dumps.

**Contenido:**

```
manifest.json
app/          backend: el repo compilado (dist/, node_modules/ con devDependencies, package.json,
                       migrations/, scripts/, config de sequelize). Sin .git ni .env.
              frontend: el contenido de dist/ (index.html, assets/...).
ansible/      update.yml, ansible.cfg, group_vars/all.yml, roles/update_backend, roles/update_frontend
```

**`manifest.json`:**

```json
{
  "format": 1,
  "component": "backend",
  "repo": "https://github.com/Jalter-ego/attendance-core.git",
  "ref": "develop",
  "commit": "<40 caracteres>",
  "version": "<sha12>",
  "node": "24.15.0",
  "built_at": "2026-11-14T15:00:00Z"
}
```

**Reglas de build:**

- Se compila en **Linux x86_64** (WSL, CI o el contenedor del worker). En Windows los enlaces de `node_modules` no sobreviven al `tar`.
- Backend: `pnpm install --frozen-lockfile` con devDependencies (las migraciones usan `sequelize-cli`), `pnpm build`. Core no usa módulos nativos (`bcryptjs`, `pg`), así que el paquete corre en la VM sin compilar nada.
- Frontend: `pnpm build` **sin** `VITE_API_URL`, igual que la AMI: usa la ruta relativa `/core/api/v1` y sirve para cualquier tenant.

## 3. Qué hace `update.yml` en la VM

Lo lanza Run Command como root, bajo un candado (`flock`) para que no corran dos actualizaciones a la vez. Escribe el resultado en `/var/lib/attendance/update.json`. Si el paquete se rechaza antes de empezar (manifest de otro componente, checksum), no hay `update.json` y el script devuelve `failed` con el error de Ansible.

| Paso | Backend | Frontend |
|---|---|---|
| 1 | Valida `manifest.json` (componente = rol de la VM) | Igual |
| 2 | Release en `/opt/attendance/releases/backend-<sha12>` (root:attendance, sin permisos para otros) | Release en `/opt/attendance/releases/frontend-<sha12>`. La primera vez mueve el build horneado a `frontend-<commit de image.json>` y convierte `/var/www/attendance` en enlace |
| 3 | Migraciones (`sequelize-cli db:migrate`) con `backend.env` | — |
| 4 | Cambia el enlace `backend-current` de forma atómica | Cambia el enlace `/var/www/attendance` de forma atómica |
| 5 | Reinicia `attendance-backend` y espera `GET /core/api/v1/health` = 200 (90 s) | Recarga nginx y comprueba que `/` devuelve el `index.html` nuevo |
| 6 | **Si falla:** vuelve el enlace a la release anterior y reinicia | **Si falla:** vuelve el enlace anterior y recarga |
| 7 | Conserva las 3 últimas releases (nunca borra la actual ni la anterior) | Igual |

**Migraciones y vuelta atrás:** la vuelta atrás restaura el código, **no** la base. Las migraciones de core deben ser compatibles hacia atrás (agregar, no borrar). Para el backend en `prod` el worker debería lanzar antes un respaldo (`tenant-backup.sh backup`).

## 4. Resultado

`tenant-update.sh` imprime progreso legible y, en la **última línea**, un JSON (mismo estilo que `tenant-backup.sh`). Código de salida 0 solo si `status = "succeeded"`.

```json
{
  "status": "succeeded",
  "tenant": "colegio-a",
  "env": "test",
  "component": "backend",
  "instance_id": "i-0123456789abcdef0",
  "from": "ecf3f46a1b2c",
  "to": "9f8e7d6c5b4a",
  "rolled_back": false,
  "health": { "url": "http://127.0.0.1:5000/core/api/v1/health", "status": 200 },
  "command_id": "…",
  "finished_at": "2026-11-14T15:03:12Z"
}
```

| `status` | Significado | Qué hace el worker |
|---|---|---|
| `succeeded` | Nueva versión activa y sana | Guardar `to` como versión del tenant |
| `rolled_back` | La nueva no pasó el health; quedó la anterior (`from`) funcionando | Marcar la operación como fallida; el tenant sigue sano en `from` |
| `failed` | Error antes del cambio (descarga, checksum, migración) o la vuelta atrás tampoco quedó sana | Fallida; revisar `error` y comprobar salud con `tenant-health.sh` |

En `rolled_back` y `failed` se agrega `"error": "<mensaje corto>"`.

## 5. Comandos

```bash
# 1) Compilar (Linux). Deja el paquete y su .sha256 en ./dist-releases/
infra/app-update/build-release.sh --component backend --ref develop

# 2) Publicar en el prefijo del tenant (credenciales de la plataforma, no de la EC2)
infra/app-update/tenant-update.sh publish --tenant colegio-a --env test \
  --file dist-releases/backend-9f8e7d6c5b4a.tar.gz

# 3) Aplicar en la EC2 del tenant
infra/app-update/tenant-update.sh apply --tenant colegio-a --env test \
  --component backend --version 9f8e7d6c5b4a

# Ver qué versión corre y qué paquetes hay
infra/app-update/tenant-update.sh status --tenant colegio-a --env test
```

Opciones comunes: `--region` (por defecto `us-east-2` o `$AWS_REGION`), `--bucket` (por defecto `<project>-backups-<cuenta>`), `--project` (`attendance-platform`), `--timeout` en segundos (600).

`apply` envía por Run Command (`AWS-RunShellScript`, en base64) el script `infra/app-update/remote-apply.sh`: descarga el paquete con el rol IAM de la EC2, verifica el sha256, extrae y corre `ansible/update.yml`. Tampoco está horneado en la AMI. El log completo queda en la VM en `/var/log/attendance-update.log`.

`status` devuelve, en la última línea:

```json
{"tenant":"colegio-a","env":"test",
 "vms":[{"instance_id":"i-…","role":"backend","current":"ecf3f46d0e9f","image_version":"0.2.2","last_update":{…JSON de §4…}},
        {"instance_id":"i-…","role":"frontend","current":"2f9caca94482","image_version":"0.2.2","last_update":null}],
 "packages":[{"key":"tenants/colegio-a/test/releases/backend-ecf3f46d0e9f.tar.gz","bytes":59594594,"last_modified":"…"}]}
```

`current` vale `horneado` en un frontend que nunca se actualizó.

**Permisos de quien lo ejecuta** (worker u operador; no van en las EC2): `s3:PutObject`/`GetObject`/`ListBucket` en `tenants/*/releases/*`, `ssm:SendCommand` sobre `AWS-RunShellScript` y las instancias del proyecto, `ssm:GetCommandInvocation`, `ec2:DescribeInstances`.

## 6. Pruebas locales (sin AWS)

En `infra/ansible/tests/update/`, con Docker Desktop, desde Git Bash:

| Script | Qué prueba |
|---|---|
| `run.sh` | Los roles con una app falsa: éxito, vuelta atrás, migración fallida, misma versión, paquete ajeno, primer cambio del frontend, limpieza de releases (10 comprobaciones) |
| `e2e.sh` | El flujo completo `publish → apply → status` de `tenant-update.sh` con los paquetes **reales** de `build-release.sh`, PostgreSQL y migraciones reales; un backend roto vuelve atrás; la VM y los datos se conservan; `tenant-health.sh` sano, API caída (502), BD caída (503), recuperación y frontend sin respuesta (20 comprobaciones). La AWS CLI se reemplaza por `fake-aws.sh`, que por defecto responde con `\r\n` como la de Windows del worker (`FAKE_CRLF=0` para desactivarlo) |

## 7. Cómo se prueba en AWS (para la defensa de RF-15)

1. Anotar el ID de la EC2 backend y crear un dato en la app (un módulo).
2. `build-release.sh` de otro commit → `publish` → `apply`.
3. Comprobar: mismo ID de EC2, el dato sigue, `status` muestra la versión nueva, `/health` 200.
4. Forzar un fallo (paquete con `dist/src/main.js` roto) → `apply` devuelve `rolled_back` y la app sigue en la versión anterior.

## 8. Health check del tenant (E6) — `infra/health/tenant-health.sh`

Un tenant no está listo hasta pasar este chequeo (`docs/contratos-integracion.md`). El worker lo corre después de crear, reanudar o actualizar un tenant, igual que `tenant-backup.sh`: Git Bash + AWS CLI, JSON en la última línea, código 0 solo si está sano.

```bash
infra/health/tenant-health.sh --tenant colegio-a --env test --url "<outputs.urls.frontend>" [--boot] [--timeout 300]
```

- Sin `--url` busca la IP pública de la EC2 frontend en ejecución por etiquetas (`Project/Tenant/Env/Role`).
- Comprueba por el nginx público `GET /healthz` (frontend) y `GET /core/api/v1/health` (nginx → API → PostgreSQL). Reintenta cada `--interval` (5 s) hasta `--timeout` (300 s): un tenant recién creado tarda ~90 s.
- `--boot` lee además `/var/lib/attendance/boot.json` de las 3 VMs por Run Command (`booting | ready | failed` + mensaje): explica por qué no está sano.

```json
{"tenant":"colegio-a","env":"test","status":"unhealthy",
 "reason":"la API responde pero no llega a su base de datos",
 "url":"http://3.14.15.92/",
 "checks":{"frontend":{"url":"http://3.14.15.92/healthz","status":200,"ms":41},
           "backend":{"url":"http://3.14.15.92/core/api/v1/health","status":503,"ms":57,"body":"{status:error}"}},
 "attempts":60,"elapsed_s":301,"boot":null,"checked_at":"2026-11-14T19:54:33Z"}
```

| `checks` | `reason` |
|---|---|
| frontend `0` | el frontend no responde (VM apagada, arrancando o sin IP pública) |
| backend `502`/`504` | nginx no llega al backend (API caída o arrancando) |
| backend `503` | la API responde pero no llega a su base de datos |
| ambos `200` | `null` → `status: healthy` |
