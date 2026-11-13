#!/bin/bash
# Deja la instancia de build lista para correr Ansible en modo local.
# ansible-core queda instalado en la AMI: cloud-init lo vuelve a usar en el primer arranque.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# Esperar a que cloud-init de la instancia de build termine (libera el lock de apt).
cloud-init status --wait >/dev/null || true

apt-get -o Acquire::Retries=3 update
apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  ansible-core python3-apt ca-certificates curl unzip jq git xz-utils

ansible --version | head -1
