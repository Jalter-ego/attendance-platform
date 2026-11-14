#!/usr/bin/env bash
# make-app.sh <backend|frontend> <etiqueta> <ok|broken|migrate-fail|no-index> <carpeta destino>
# Genera una app falsa: el backend es un servidor node con /core/api/v1/health.
set -euo pipefail
COMP=$1 LABEL=$2 MODE=$3 DEST=$4
mkdir -p "$DEST"
if [ "$COMP" = backend ]; then
  mkdir -p "$DEST/dist/src" "$DEST/node_modules/.bin"
  if [ "$MODE" = broken ]; then
    echo 'console.error("arranque roto"); process.exit(1);' > "$DEST/dist/src/main.js"
  else
    cat > "$DEST/dist/src/main.js" <<JS
require('http').createServer((q, r) => {
  if (q.url === '/core/api/v1/health') { r.writeHead(200, {'content-type':'application/json'}); r.end(JSON.stringify({ok:true, version:'$LABEL'})); }
  else { r.writeHead(404); r.end(); }
}).listen(process.env.PORT || 5000);
JS
  fi
  if [ "$MODE" = migrate-fail ]; then
    printf '#!/bin/sh\necho "ERROR: relation \\"students\\" already exists" >&2\nexit 1\n' > "$DEST/node_modules/.bin/sequelize-cli"
  else
    printf '#!/bin/sh\necho "No migrations were executed, database schema was already up to date."\n' > "$DEST/node_modules/.bin/sequelize-cli"
  fi
  chmod +x "$DEST/node_modules/.bin/sequelize-cli"
else
  [ "$MODE" = no-index ] || echo "<html><body>build $LABEL</body></html>" > "$DEST/index.html"
  mkdir -p "$DEST/assets"; echo "console.log('$LABEL')" > "$DEST/assets/app.js"
fi
