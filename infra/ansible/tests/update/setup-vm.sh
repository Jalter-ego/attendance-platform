#!/usr/bin/env bash
# Deja el contenedor como una VM ya arrancada por boot.yml (AMI 0.2.2): backend y frontend en la misma.
set -euo pipefail
ROOT=/opt/attendance ETC=/etc/attendance STATE=/var/lib/attendance
id attendance >/dev/null 2>&1 || useradd --system --home-dir $ROOT --no-create-home --shell /usr/sbin/nologin attendance
install -d -m 0755 $ROOT $STATE $ROOT/releases
install -d -m 0750 $ETC

cat > $ETC/image.json <<'J'
{"role":"backend","image_version":"0.2.2","backend_commit":"aaaaaaaaaaaa1111111111111111111111111111","frontend_commit":"ffffffffffff0000000000000000000000000000"}
J
cat > $ETC/backend.env <<'E'
NODE_ENV=production
PORT=5000
APP_VERSION=desde-env
E
chown root:attendance $ETC/backend.env; chmod 0640 $ETC/backend.env

# Backend horneado
B=$ROOT/releases/backend-aaaaaaaaaaaa
/test/make-app.sh backend horneado ok "$B"
chown -R root:attendance "$B"; chmod -R u=rwX,g=rX,o= "$B"
ln -sfn "$B" $ROOT/backend-current

cat > /etc/systemd/system/attendance-backend.service <<'U'
[Unit]
Description=Attendance NestJS API (simulada)
ConditionPathExists=/etc/attendance/backend.env
[Service]
Type=simple
User=attendance
Group=attendance
WorkingDirectory=/opt/attendance/backend-current
EnvironmentFile=/etc/attendance/backend.env
ExecStart=/usr/local/bin/node dist/src/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0027
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload
systemctl enable --now attendance-backend

# Frontend horneado (carpeta real, como en la AMI)
rm -rf /var/www/attendance; mkdir -p /var/www/attendance
echo '<html><body>build horneado</body></html>' > /var/www/attendance/index.html
cat > /etc/nginx/sites-available/attendance <<'N'
server {
    listen 80 default_server;
    root /var/www/attendance;
    index index.html;
    location = /healthz { default_type text/plain; return 200 "ok\n"; }
    location / { try_files $uri $uri/ /index.html; }
}
N
ln -sfn /etc/nginx/sites-available/attendance /etc/nginx/sites-enabled/attendance
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx && systemctl reload nginx

sleep 2
curl -fsS http://127.0.0.1:5000/core/api/v1/health; echo
curl -fsS http://127.0.0.1/; echo "VM lista"
