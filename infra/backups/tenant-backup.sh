#!/usr/bin/env bash
# Respaldos de un tenant desde la plataforma (worker de P6 o un operador). Requiere AWS CLI v2.
#
#   tenant-backup.sh backup  --tenant <id> --env <test|prod>
#       dump lógico en la VM db (SSM Run Command) + snapshot EBS etiquetado con el mismo id
#   tenant-backup.sh restore --tenant <id> --env <test|prod> --id <backup_id|latest>
#       restaura el dump en la VM db (antes deja una copia pre-restore)
#   tenant-backup.sh list    --tenant <id> --env <test|prod>
#       dumps en S3 y snapshots EBS del tenant (JSON)
#   tenant-backup.sh prune   --tenant <id> --env <test|prod>
#       borra los snapshots MANUALES vencidos (etiqueta RetentionDays). Los dumps los
#       vence el lifecycle de S3 y los snapshots programados, DLM.
#
# Opciones: --region (por defecto us-east-2 o $AWS_REGION), --bucket (por defecto el de la
# base: <project>-backups-<cuenta>), --project (attendance-platform), --timeout seg (900).
# Salida: progreso legible y, en la última línea, JSON para la API. Código != 0 si falla.
set -euo pipefail

CMD="${1:-}"; shift || true
TENANT="" ENV_NAME="" BACKUP_ID="" REGION="${AWS_REGION:-us-east-2}" PROJECT="attendance-platform" BUCKET="" TIMEOUT=900
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --id) BACKUP_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "ERROR: opción desconocida $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$CMD" =~ ^(backup|restore|list|prune)$ ]] || die "uso: tenant-backup.sh <backup|restore|list|prune> --tenant ID --env test|prod [--id ID|latest]"
[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] || die "--tenant inválido"
[[ "$ENV_NAME" =~ ^(test|prod)$ ]] || die "--env debe ser test o prod"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
# Git Bash en Windows convierte "/tenants/..." en rutas de Windows; aquí no queremos eso.
export MSYS_NO_PATHCONV=1

if [ -z "$BUCKET" ]; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  BUCKET="$PROJECT-backups-$ACCOUNT"
fi
PREFIX="tenants/$TENANT/$ENV_NAME"
TAGS=(Name=tag:Project,Values="$PROJECT" Name=tag:Tenant,Values="$TENANT" Name=tag:Env,Values="$ENV_NAME" Name=tag:Role,Values=db)

db_instance() {
  local id
  id=$(aws ec2 describe-instances --filters "${TAGS[@]}" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId | [0]' --output text)
  [ -n "$id" ] && [ "$id" != None ] || die "no hay una VM db en ejecución para $TENANT/$ENV_NAME (¿suspendido?)"
  echo "$id"
}

db_volume() {
  aws ec2 describe-volumes --filters "${TAGS[@]}" --query 'Volumes[0].VolumeId' --output text
}

# Ejecuta un comando en la VM db con Run Command, muestra su salida y deja la última
# línea (JSON) en RUN_RESULT.
run_on_db() {
  local instance="$1" command="$2" comment="$3" cmd_id status waited=0
  cmd_id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --comment "$comment" --timeout-seconds 60 \
    --parameters "{\"commands\":[\"$command\"],\"executionTimeout\":[\"$TIMEOUT\"]}" \
    --query Command.CommandId --output text) || die "SSM no aceptó el comando (¿agente registrado? ver docs/respaldos.md)"
  echo "== SSM $cmd_id en $instance: $command"
  while :; do
    status=$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in
      Success | Failed | Cancelled | TimedOut | Cancelling) break ;;
    esac
    [ "$waited" -ge "$TIMEOUT" ] && die "tiempo de espera agotado ($TIMEOUT s), comando $cmd_id"
    sleep 5; waited=$((waited + 5))
  done
  local out err
  out=$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query StandardOutputContent --output text)
  err=$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
    --query StandardErrorContent --output text)
  [ -n "$out" ] && printf '%s\n' "$out"
  [ -n "$err" ] && [ "$err" != None ] && printf '%s\n' "$err" >&2
  [ "$status" = Success ] || die "el comando terminó en estado $status (ver la salida de arriba)"
  RUN_RESULT=$(printf '%s\n' "$out" | grep -E '^\{' | tail -n 1)
}

case "$CMD" in
  backup)
    INSTANCE=$(db_instance)
    run_on_db "$INSTANCE" "/usr/local/sbin/attendance-backup manual" "backup $TENANT/$ENV_NAME"
    DUMP_JSON="$RUN_RESULT"
    ID=$(sed -E 's/.*"backup_id":"([^"]+)".*/\1/' <<<"$DUMP_JSON")
    RET=$(sed -E 's/.*"retention_days":([0-9]+).*/\1/' <<<"$DUMP_JSON")
    VOL=$(db_volume)
    SNAP=""
    if [ -n "$VOL" ] && [ "$VOL" != None ]; then
      echo "== snapshot EBS de $VOL"
      SNAP=$(aws ec2 create-snapshot --volume-id "$VOL" \
        --description "attendance $TENANT/$ENV_NAME $ID" \
        --tag-specifications "ResourceType=snapshot,Tags=[{Key=Project,Value=$PROJECT},{Key=Tenant,Value=$TENANT},{Key=Env,Value=$ENV_NAME},{Key=Role,Value=db},{Key=BackupId,Value=$ID},{Key=BackupType,Value=manual},{Key=RetentionDays,Value=$RET}]" \
        --query SnapshotId --output text)
    fi
    echo "== respaldo $ID listo (snapshot ${SNAP:-ninguno})"
    printf '{"tenant":"%s","env":"%s","backup_id":"%s","dump":%s,"snapshot_id":"%s"}\n' \
      "$TENANT" "$ENV_NAME" "$ID" "$DUMP_JSON" "$SNAP"
    ;;

  restore)
    [ -n "$BACKUP_ID" ] || die "restore necesita --id <backup_id|latest>"
    [[ "$BACKUP_ID" =~ ^(latest|[0-9]{8}T[0-9]{6}Z-(manual|scheduled|pre-restore))$ ]] || die "--id inválido"
    INSTANCE=$(db_instance)
    run_on_db "$INSTANCE" "/usr/local/sbin/attendance-restore $BACKUP_ID" "restore $TENANT/$ENV_NAME $BACKUP_ID"
    printf '{"tenant":"%s","env":"%s","result":%s}\n' "$TENANT" "$ENV_NAME" "$RUN_RESULT"
    ;;

  list)
    DUMPS=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/db/" \
      --query "Contents[].{key: Key, bytes: Size, last_modified: LastModified}" --output json)
    [ "$DUMPS" = null ] && DUMPS="[]"
    SNAPS=$(aws ec2 describe-snapshots --owner-ids self \
      --filters Name=tag:Project,Values="$PROJECT" Name=tag:Tenant,Values="$TENANT" Name=tag:Env,Values="$ENV_NAME" \
      --query "Snapshots[].{snapshot_id: SnapshotId, state: State, started: StartTime, gib: VolumeSize, backup_id: Tags[?Key=='BackupId']|[0].Value, type: Tags[?Key=='BackupType']|[0].Value}" \
      --output json)
    printf '{"tenant":"%s","env":"%s","bucket":"%s","dumps":%s,"snapshots":%s}\n' \
      "$TENANT" "$ENV_NAME" "$BUCKET" "$(tr -d '\n' <<<"$DUMPS")" "$(tr -d '\n' <<<"$SNAPS")"
    ;;

  prune)
    NOW=$(date -u +%s)
    DELETED=()
    while read -r snap started days; do
      [ -n "$snap" ] && [ "$snap" != None ] || continue
      age_days=$(( (NOW - $(date -u -d "$started" +%s)) / 86400 ))
      if [ "$age_days" -ge "${days:-28}" ]; then
        echo "== borrando $snap ($age_days días, retención ${days:-28} días)"
        aws ec2 delete-snapshot --snapshot-id "$snap"
        DELETED+=("\"$snap\"")
      fi
    done < <(aws ec2 describe-snapshots --owner-ids self \
      --filters Name=tag:Project,Values="$PROJECT" Name=tag:Tenant,Values="$TENANT" Name=tag:Env,Values="$ENV_NAME" Name=tag:BackupType,Values=manual \
      --query "Snapshots[].[SnapshotId, StartTime, Tags[?Key=='RetentionDays']|[0].Value]" --output text)
    printf '{"tenant":"%s","env":"%s","deleted":[%s]}\n' "$TENANT" "$ENV_NAME" "$(IFS=,; echo "${DELETED[*]:-}")"
    ;;
esac
