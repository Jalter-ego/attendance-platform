#!/usr/bin/env bash
# Pruebas de aislamiento entre dos tenants (E7 · J5, §9 del plan). Requiere AWS CLI v2 y curl,
# credenciales de la plataforma (no las de una EC2) y los dos tenants desplegados y sanos.
#
#   tests/isolation.sh --a <tenant>/<env> --b <tenant>/<env> [--keep-marker] [--evidence DIR]
#
# Cada prueba tiene un CONTROL positivo (lo propio sí funciona) para que un "falla" signifique
# aislamiento y no un error de red o de configuración:
#   1. Red (SG)       backend A → BD de A abre; backend A → BD de B NO abre (y al revés).
#   2. Credenciales   las contraseñas de BD y JWT de A y B son distintas; la BD de A rechaza
#                     cualquier contraseña que no sea la suya (por tanto, la de B) y acepta la propia.
#   3. Token          un token de la app de A vale en A y NO en la API de B (401).
#   4. IAM/SSM        el backend de A lee sus parámetros y NO los de B; el frontend no lee secretos;
#                     el backend de A NO lista los paquetes de B en S3.
#   5. Datos          un módulo creado en A aparece en la BD de A y NO en la API ni en la BD de B.
# La 6 (admin de tenant solo ve su tenant en la plataforma/Grafana) es de P5/P6.
#
# Ningún secreto viaja por Run Command ni aparece en la salida: las contraseñas se comparan en
# esta máquina y en la VM se usan las que ya tiene (backend.env). La prueba 4 usa get-parameters
# SIN descifrar: comprueba el permiso, no lee el valor.
#
# Opciones: --region (us-east-2 o $AWS_REGION), --project (attendance-platform), --bucket
# (<project>-backups-<cuenta>), --keep-marker (no borra el módulo de prueba de A), --evidence DIR
# (guarda la salida completa con fecha). Salida: progreso y, en la última línea, JSON.
# Código 0 solo si pasan todas.
set -euo pipefail

A="" B="" REGION="${AWS_REGION:-us-east-2}" PROJECT="attendance-platform" BUCKET="" KEEP=false EVIDENCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --a) A="$2"; shift 2 ;;
    --b) B="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --keep-marker) KEEP=true; shift ;;
    --evidence) EVIDENCE="$2"; shift 2 ;;
    *) echo "ERROR: opción desconocida $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
ID_RE='^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]/(test|prod)$'
[[ "$A" =~ $ID_RE && "$B" =~ $ID_RE ]] || die "uso: isolation.sh --a <tenant>/<test|prod> --b <tenant>/<test|prod>"
[ "$A" != "$B" ] || die "--a y --b deben ser tenants distintos"
command -v curl >/dev/null || die "falta curl"

if [ -n "$EVIDENCE" ]; then
  mkdir -p "$EVIDENCE"
  LOG="$EVIDENCE/isolation-${A//\//-}-vs-${B//\//-}-$(date -u +%Y%m%dT%H%M%SZ).log"
  exec > >(tee "$LOG") 2>&1
fi

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" MSYS_NO_PATHCONV=1 AWS_CLI_OUTPUT_ENCODING=UTF-8
aws_text() { aws "$@" --output text | tr -d '\r'; }
if [ -z "$BUCKET" ]; then BUCKET="$PROJECT-backups-$(aws_text sts get-caller-identity --query Account)"; fi

# ---------------------------------------------------------------------------------------------
# Descubrimiento por etiquetas (Project/Tenant/Env/Role), igual que tenant-backup.sh.
# ---------------------------------------------------------------------------------------------
# describe <tenant/env> <rol> <campo JMESPath>
describe() {
  local tenant=${1%/*} env=${1#*/}
  aws_text ec2 describe-instances --filters Name=tag:Project,Values="$PROJECT" Name=tag:Tenant,Values="$tenant" \
    Name=tag:Env,Values="$env" Name=tag:Role,Values="$2" Name=instance-state-name,Values=running \
    --query "Reservations[].Instances[].$3 | [0]"
}
declare -A ID IP URL
for t in A B; do
  name=${!t}
  for role in frontend backend db; do
    ID[$t.$role]=$(describe "$name" "$role" InstanceId)
    [ -n "${ID[$t.$role]}" ] && [ "${ID[$t.$role]}" != None ] || die "$name no tiene una VM $role en ejecución (¿suspendido?)"
  done
  IP[$t.db]=$(describe "$name" db PrivateIpAddress)
  URL[$t]="http://$(describe "$name" frontend PublicIpAddress)"
done
echo "== A = $A  (${URL[A]}, BD ${IP[A.db]})"
echo "== B = $B  (${URL[B]}, BD ${IP[B.db]})"

# Run Command: el script viaja en base64 (sin comillas que escapar). Deja la salida en RUN_OUT.
run() {
  local instance=$1 script=$2 b64 cmd_id status="" waited=0
  b64=$(printf '%s\n' "$script" | base64 | tr -d '\n')
  cmd_id=$(aws_text ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --comment "isolation $A vs $B" --timeout-seconds 60 \
    --parameters "{\"commands\":[\"echo $b64 | base64 -d | bash\"],\"executionTimeout\":[\"120\"]}" \
    --query Command.CommandId) || die "SSM no aceptó el comando en $instance"
  while :; do
    status=$(aws_text ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" --query Status 2>/dev/null || echo Pending)
    case "$status" in Success | Failed | Cancelled | TimedOut) break ;; esac
    [ "$waited" -ge 180 ] && break
    sleep 3; waited=$((waited + 3))
  done
  RUN_OUT=$(aws_text ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query StandardOutputContent 2>/dev/null || true)
}

RESULTS=() PASS=0 FAIL=0
# check <id> <nombre> <0 = pasa> <detalle>
check() {
  local ok=$3 mark
  if [ "$ok" -eq 0 ]; then PASS=$((PASS + 1)); mark=OK; else FAIL=$((FAIL + 1)); mark=FALLA; fi
  printf '%-6s %-4s %-62s %s\n' "$mark" "$1" "$2" "$4"
  RESULTS+=("{\"id\":\"$1\",\"name\":\"$2\",\"result\":\"$( [ "$ok" -eq 0 ] && echo passed || echo failed)\",\"detail\":\"${4//\"/\'}\"}")
}
is() { [ "$1" = "$2" ] && echo 0 || echo 1; }
# pick <clave>: valor de "clave=valor" en RUN_OUT; vacío si no está (no corta el script).
pick() { { grep -o -- "$1=[A-Za-z0-9]*" <<<"$RUN_OUT" || true; } | head -n 1 | cut -d= -f2; }

# ---------------------------------------------------------------------------------------------
echo; echo "== 1. Red: Security Groups"
PORT_SCRIPT='for ip in "$@"; do if timeout 4 bash -c "</dev/tcp/$ip/5432" 2>/dev/null; then echo "$ip=open"; else echo "$ip=closed"; fi; done'
for pair in "A B" "B A"; do
  set -- $pair; own=$1 other=$2
  run "${ID[$own.backend]}" "set -- ${IP[$own.db]} ${IP[$other.db]}; $PORT_SCRIPT"
  got_own=$(pick "${IP[$own.db]}")
  got_other=$(pick "${IP[$other.db]}")
  check "1.$own" "backend $own → BD de $own:5432 (control)" "$(is "$got_own" open)" "${got_own:-sin respuesta}"
  check "1.$own" "backend $own → BD de $other:5432 bloqueado" "$(is "$got_other" closed)" "${got_other:-sin respuesta}"
done

# ---------------------------------------------------------------------------------------------
echo; echo "== 2. Credenciales de BD y JWT"
secret() { aws_text ssm get-parameter --name "/tenants/$1/$2" --with-decryption --query Parameter.Value; }
for key in db_password jwt_secret; do
  sa=$(secret "$A" "$key") sb=$(secret "$B" "$key")
  if [ -n "$sa" ] && [ -n "$sb" ] && [ "$sa" != "$sb" ]; then ok=0; else ok=1; fi
  check "2" "$key de A ≠ $key de B" "$ok" "comparadas aquí; no se muestran"
done
unset sa sb
# En la VM de A: su contraseña (de backend.env) entra; una distinta (cualquiera, incluida la de B)
# se rechaza con 28P01. Se usa el cliente pg que ya trae la app.
PG_SCRIPT='set -a; . /etc/attendance/backend.env; set +a
cd /opt/attendance/backend-current
try() { PGTRY="$1" node -e "
  const { Client } = require(\"pg\");
  const c = new Client({ host: process.env.DB_WRITE_HOST, port: +process.env.DB_WRITE_PORT, user: process.env.DB_WRITE_USERNAME,
    password: process.env.PGTRY, database: process.env.DB_WRITE_NAME, connectionTimeoutMillis: 5000 });
  c.connect().then(() => { console.log(\"$2=ok\"); return c.end(); }).catch((e) => console.log(\"$2=\" + (e.code || \"error\")));"; }
try "$DB_WRITE_PASSWORD" own
try "otra-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d " \n")" other'
run "${ID[A.backend]}" "$PG_SCRIPT"
got_own=$(pick "own")
got_other=$(pick "other")
check "2" "BD de A acepta su propia contraseña (control)" "$(is "$got_own" ok)" "${got_own:-sin respuesta}"
check "2" "BD de A rechaza otra contraseña (p. ej. la de B)" "$(is "$got_other" 28P01)" "${got_other:-sin respuesta}"

# ---------------------------------------------------------------------------------------------
echo; echo "== 3. Token de la app"
# login <A|B>: token del administrador inicial (correo de tenant.json, contraseña de SSM).
login() {
  local t=$1 email password body
  run "${ID[$t.backend]}" 'jq -r .admin_email /etc/attendance/tenant.json'
  email=$(tr -d '[:space:]' <<<"$RUN_OUT")
  password=$(secret "${!t}" admin_password)
  # La contraseña va por stdin, no en la línea de comandos.
  body=$(printf '{"email":"%s","password":"%s"}' "$email" "$password" |
    curl -s -m 15 -H 'Content-Type: application/json' --data @- "${URL[$t]}/core/api/v1/auth/admin/login" || true)
  sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p' <<<"$body"
}
status_of() { curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $2" "$1" || true; }
TOKEN_A=$(login A); TOKEN_B=$(login B)
[ -n "$TOKEN_A" ] && [ -n "$TOKEN_B" ] || echo "AVISO: no se pudo iniciar sesión en A o B (¿admin inicial creado?)"
for pair in "A B" "B A"; do
  set -- $pair; own=$1 other=$2; token_var=TOKEN_$own
  code_own=$(status_of "${URL[$own]}/core/api/v1/auth/me" "${!token_var}")
  code_other=$(status_of "${URL[$other]}/core/api/v1/auth/me" "${!token_var}")
  check "3.$own" "token de $own en la API de $own (control)" "$(is "$code_own" 200)" "HTTP $code_own"
  check "3.$own" "token de $own en la API de $other rechazado" "$(is "$code_other" 401)" "HTTP $code_other"
done

# ---------------------------------------------------------------------------------------------
echo; echo "== 4. IAM: SSM y S3"
# get-parameters SIN --with-decryption: prueba el permiso, no lee el valor.
SSM_SCRIPT='region=$(jq -r .region /etc/attendance/tenant.json)
for p in "$@"; do
  if aws ssm get-parameters --region "$region" --names "$p" --query "Parameters[0].Name" --output text >/dev/null 2>/tmp/ssm.err; then echo "$p=allowed"
  elif grep -q AccessDenied /tmp/ssm.err; then echo "$p=denied"; else echo "$p=error"; fi
done'
run "${ID[A.backend]}" "set -- /tenants/$A/db_password /tenants/$B/db_password; $SSM_SCRIPT"
got_own=$(pick "/tenants/$A/db_password")
got_other=$(pick "/tenants/$B/db_password")
check "4" "backend A lee /tenants/$A/* (control)" "$(is "$got_own" allowed)" "${got_own:-sin respuesta}"
check "4" "backend A NO lee /tenants/$B/*" "$(is "$got_other" denied)" "${got_other:-sin respuesta}"
run "${ID[A.frontend]}" "set -- /tenants/$A/db_password; $SSM_SCRIPT"
got=$(pick "/tenants/$A/db_password")
check "4" "frontend A NO lee secretos (ni los suyos)" "$(is "$got" denied)" "${got:-sin respuesta}"
S3_SCRIPT='region=$(jq -r .region /etc/attendance/tenant.json)
if aws s3 ls --region "$region" "s3://$1/tenants/$2/releases/" >/dev/null 2>/tmp/s3.err; then echo "s3=allowed"
elif grep -q AccessDenied /tmp/s3.err; then echo "s3=denied"; else echo "s3=error"; fi'
run "${ID[A.backend]}" "set -- $BUCKET $B; $S3_SCRIPT"
got=$(pick "s3")
check "4" "backend A NO lista releases/ de B en S3" "$(is "$got" denied)" "${got:-sin respuesta}"

# ---------------------------------------------------------------------------------------------
echo; echo "== 5. Datos"
MARKER="aislamiento-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  --data "{\"name\":\"$MARKER\"}" "${URL[A]}/core/api/v1/modules" || true)
check "5" "crear el módulo $MARKER en A (control)" "$( [ "$code" = 201 ] || [ "$code" = 200 ] && echo 0 || echo 1)" "HTTP $code"
listed=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN_B" "${URL[B]}/core/api/v1/modules" || true)
if [ -n "$listed" ] && ! grep -q "$MARKER" <<<"$listed"; then ok=0; else ok=1; fi
check "5" "la API de B no lo lista" "$ok" "GET /modules en B"
COUNT_SCRIPT="runuser -u postgres -- psql -d attendance -tAc \"SELECT count(*) FROM modules WHERE name = '$MARKER'\""
run "${ID[A.db]}" "$COUNT_SCRIPT"; in_a=$(tr -d '[:space:]' <<<"$RUN_OUT")
run "${ID[B.db]}" "$COUNT_SCRIPT"; in_b=$(tr -d '[:space:]' <<<"$RUN_OUT")
check "5" "está en la BD de A (control)" "$(is "$in_a" 1)" "filas: ${in_a:-?}"
check "5" "NO está en la BD de B" "$(is "$in_b" 0)" "filas: ${in_b:-?}"
if ! $KEEP; then
  run "${ID[A.db]}" "runuser -u postgres -- psql -d attendance -tAc \"DELETE FROM modules WHERE name = '$MARKER'\""
  echo "   (módulo de prueba borrado de A; --keep-marker para conservarlo)"
fi

# ---------------------------------------------------------------------------------------------
echo
STATUS=passed; [ "$FAIL" -eq 0 ] || STATUS=failed
echo "== $PASS correctas, $FAIL fallidas${LOG:+   (evidencia: $LOG)}"
printf '{"status":"%s","a":"%s","b":"%s","passed":%s,"failed":%s,"marker":"%s","checks":[%s],"checked_at":"%s"}\n' \
  "$STATUS" "$A" "$B" "$PASS" "$FAIL" "$MARKER" "$(IFS=,; echo "${RESULTS[*]}")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$FAIL" -eq 0 ]
