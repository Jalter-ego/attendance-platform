#!/bin/bash
# Limpia la instancia de build para que cada VM que salga de la AMI arranque "como nueva".
set -euo pipefail

apt-get -y autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Datos que deben ser únicos por VM: se regeneran en el primer arranque.
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id

# Que cloud-init vuelva a ejecutar user_data en cada VM nueva.
cloud-init clean --logs --seed

# Sin historial ni llaves de la sesión de Packer.
rm -f /home/ubuntu/.ssh/authorized_keys /root/.bash_history /home/ubuntu/.bash_history
sync
