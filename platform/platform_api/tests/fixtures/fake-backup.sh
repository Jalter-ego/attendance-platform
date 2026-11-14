#!/usr/bin/env bash
# Simula infra/backups/tenant-backup.sh para las pruebas. El modo sale de FAKE_MODE.
case "${FAKE_MODE:-ok}" in
  ok)
    echo "== SSM cmd-1 en i-1: /usr/local/sbin/attendance-backup manual"
    echo "== subiendo a s3://bucket/tenants/demo/test/db/20261114T150000Z-manual.dump (100 bytes)"
    echo "== snapshot EBS de vol-1"
    echo "== respaldo 20261114T150000Z-manual listo (snapshot snap-1)"
    echo "{\"tenant\":\"demo\",\"env\":\"test\",\"backup_id\":\"20261114T150000Z-manual\",\"snapshot_id\":\"snap-1\",\"args\":\"$*\"}"
    ;;
  fail)
    echo "== SSM cmd-1"
    echo "ERROR: no hay una VM db en ejecución para demo/test (¿suspendido?)" >&2
    exit 1
    ;;
  slow)
    echo "== SSM cmd-1"
    sleep 30
    echo "{}"
    ;;
esac
