#!/usr/bin/env bash
set -euo pipefail

# Ejecutar como root únicamente en la EC2 compartida de monitoreo.
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config=${1:?Uso: bash apply-monitoring.sh PROMETHEUS_AWS_JSON}
environment=/etc/attendance/observability.env

if [[ $EUID != 0 || ! -f "$environment" || $(stat -c '%a:%u' "$environment") != '600:0' ]]; then
    echo "Se requiere root y $environment con propietario root y modo 0600." >&2
    exit 1
fi

promtool check config "$config"
install -m 0644 "$config" /etc/prometheus/prometheus.yml
install -D -m 0644 "$root/grafana/dashboards/tenants.json" /var/lib/attendance/dashboards/tenants.json
for component in datasources dashboards alerting; do
    for file in "$root/grafana/provisioning/$component/"*; do
        install -D -m 0644 "$file" "/etc/grafana/provisioning/$component/${file##*/}"
    done
done

install -d -m 0755 /etc/systemd/system/grafana-server.service.d
cat > /etc/systemd/system/grafana-server.service.d/attendance-observability.conf <<'EOF'
[Service]
Environment=PROMETHEUS_URL=http://127.0.0.1:9090
Environment=PROMETHEUS_SCRAPE_INTERVAL=30s
EnvironmentFile=/etc/attendance/observability.env
EOF

systemctl daemon-reload
systemctl reload-or-restart prometheus
systemctl restart grafana-server
systemctl is-active prometheus grafana-server
