#!/usr/bin/env bash
# Arma el paquete de una release para tenant-update.sh (E2). Contrato: docs/contrato-actualizacion.md
#
#   build-release.sh --component <backend|frontend> [--ref develop] [--repo URL] [--out dist-releases]
#
# Compila igual que Packer (roles image_backend / image_frontend) y deja en --out:
#   <componente>-<sha12>.tar.gz          manifest.json + app/ + ansible/ (update.yml y sus roles)
#   <componente>-<sha12>.tar.gz.sha256
# Debe correr en Linux x86_64 (WSL, CI o el contenedor del worker): en Windows los enlaces de
# node_modules no sobreviven al tar. Requiere git, node 24, pnpm, tar y sha256sum.
# Salida: progreso legible y, en la última línea, JSON con archivo, versión y sha256.
set -euo pipefail

COMPONENT="" REF="develop" REPO="" OUT="dist-releases"
while [ $# -gt 0 ]; do
  case "$1" in
    --component) COMPONENT="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "ERROR: opción desconocida $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$COMPONENT" =~ ^(backend|frontend)$ ]] || die "uso: build-release.sh --component backend|frontend [--ref REF] [--repo URL] [--out DIR]"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "compilar en Linux x86_64 (WSL/CI): las EC2 son Linux x86_64"
for tool in git node pnpm tar sha256sum; do command -v "$tool" >/dev/null || die "falta $tool"; done

HERE=$(cd "$(dirname "$0")" && pwd)
ANSIBLE_DIR=$(cd "$HERE/../ansible" && pwd)
# Mismos valores por defecto que group_vars/all.yml (los usa Packer).
case "$COMPONENT" in
  backend) REPO=${REPO:-https://github.com/Jalter-ego/attendance-core.git} ;;
  frontend) REPO=${REPO:-https://github.com/Jalter-ego/attendance-web.git} ;;
esac
NODE_WANT=$(sed -nE 's/^node_version: *"?([0-9.]+)"?.*/\1/p' "$ANSIBLE_DIR/group_vars/all.yml")
[ "$(node -p 'process.versions.node.split(".")[0]')" = "${NODE_WANT%%.*}" ] \
  || echo "AVISO: node $(node -v) local; las VMs usan $NODE_WANT (mismo major recomendado)" >&2

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/src" STAGE="$WORK/stage"
mkdir -p "$STAGE" "$OUT"

echo "== git clone $REPO ($REF)"
git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC"
COMMIT=$(git -C "$SRC" rev-parse HEAD)
VERSION=${COMMIT:0:12}
NAME="$COMPONENT-$VERSION.tar.gz"

echo "== pnpm install + build ($VERSION)"
(
  cd "$SRC"
  export CI=true
  if [ "$COMPONENT" = backend ]; then
    # Con devDependencies: las migraciones usan sequelize-cli (igual que image_backend).
    NODE_ENV=development pnpm install --frozen-lockfile
    pnpm build
    [ -f dist/src/main.js ] || die "el build no generó dist/src/main.js"
  else
    # Sin VITE_API_URL: ruta relativa /core/api/v1, sirve para cualquier tenant (igual que la AMI).
    unset VITE_API_URL
    pnpm install --frozen-lockfile
    pnpm build
    [ -f dist/index.html ] || die "el build no generó dist/index.html"
  fi
)

echo "== armando $NAME"
if [ "$COMPONENT" = backend ]; then
  # El repo compilado sin .git ni .env (las migraciones viven en src/database/sequelize-cli).
  mkdir -p "$STAGE/app"
  tar -C "$SRC" --exclude=.git --exclude='.env' --exclude='.env.*' -cf - . | tar -C "$STAGE/app" -xf -
else
  cp -a "$SRC/dist" "$STAGE/app"
fi

# Solo lo que necesita update.yml (no boot.yml ni roles de imagen).
mkdir -p "$STAGE/ansible/roles"
cp -a "$ANSIBLE_DIR/update.yml" "$ANSIBLE_DIR/ansible.cfg" "$ANSIBLE_DIR/inventory.ini" "$ANSIBLE_DIR/group_vars" "$STAGE/ansible/"
cp -a "$ANSIBLE_DIR/roles/update_backend" "$ANSIBLE_DIR/roles/update_frontend" "$STAGE/ansible/roles/"
find "$STAGE/ansible" -type f \( -name '*.yml' -o -name '*.cfg' -o -name '*.ini' \) -exec sed -i 's/\r$//' {} +

cat > "$STAGE/manifest.json" <<JSON
{
  "format": 1,
  "component": "$COMPONENT",
  "repo": "$REPO",
  "ref": "$REF",
  "commit": "$COMMIT",
  "version": "$VERSION",
  "node": "$NODE_WANT",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

tar -C "$STAGE" --owner=0 --group=0 -czf "$OUT/$NAME" manifest.json app ansible
( cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" )
SUM=$(awk '{print $1}' "$OUT/$NAME.sha256")
BYTES=$(stat -c %s "$OUT/$NAME")
echo "== listo: $OUT/$NAME ($((BYTES / 1024 / 1024)) MB)"
printf '{"component":"%s","version":"%s","commit":"%s","file":"%s","sha256":"%s","bytes":%s}\n' \
  "$COMPONENT" "$VERSION" "$COMMIT" "$OUT/$NAME" "$SUM" "$BYTES"
