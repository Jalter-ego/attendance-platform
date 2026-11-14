#!/usr/bin/env bash
tenant='' env_name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) tenant="$2"; shift 2 ;;
    --env) env_name="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo '== comprobando frontend y backend'
if [ "${FAKE_HEALTH_MODE:-healthy}" = invalid ]; then echo 'sin JSON'; exit 1; fi
status=healthy code=200 exit_code=0
if [ "${FAKE_HEALTH_MODE:-healthy}" = unhealthy ]; then status=unhealthy; code=503; exit_code=1; fi
printf '{"tenant":"%s","env":"%s","status":"%s","checks":{"frontend":{"status":200,"ms":5},"backend":{"status":%s,"ms":5,"body":"PRIVATE_HEALTH_BODY"}},"attempts":1,"elapsed_s":0}\n' "$tenant" "$env_name" "$status" "$code"
exit "$exit_code"
