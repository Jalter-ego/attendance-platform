// Replica infra/cloud-init/user-data.yaml.tftpl (P3). Terraform la renderiza con
// templatefile(); Pulumi no interpreta plantillas HCL, así que se genera el mismo
// documento aquí. test/tenant.test.js comprueba que las claves de tenant.json coinciden
// con las de la plantilla para detectar si P3 la cambia.

/** Claves de /etc/attendance/tenant.json, en el orden de la plantilla. */
export const BOOT_KEYS = [
  'vm_role', 'tenant_id', 'env', 'plan', 'region', 'ssm_prefix', 'vpc_cidr', 'db_host',
  'backend_host', 'db_volume_id', 'institution_name', 'timezone', 'admin_email', 'limits',
  'backup_bucket', 'backup_schedule', 'backup_retention_days',
];

/** Documento #cloud-config de una VM. `boot` no contiene secretos: SSM los entrega al arrancar. */
export function renderUserData(boot) {
  const identity = Object.fromEntries(BOOT_KEYS.map((key) => [key, boot[key] ?? '']));
  return [
    '#cloud-config',
    '# Primer arranque de una VM de tenant creada por Pulumi desde una AMI de Packer.',
    '# Equivale a infra/cloud-init/user-data.yaml.tftpl: escribe la identidad del tenant y',
    '# ejecuta attendance-boot (lee SSM y corre Ansible en modo local).',
    '',
    'write_files:',
    '  - path: /etc/attendance/tenant.json',
    '    owner: root:root',
    '    permissions: "0640"',
    '    content: |',
    `      ${JSON.stringify(identity)}`,
    '',
    `timezone: ${boot.timezone}`,
    '',
    'runcmd:',
    '  - [/usr/local/sbin/attendance-boot]',
    '',
    `final_message: "attendance ${boot.vm_role} (${boot.tenant_id}/${boot.env}): cloud-init terminó en $UPTIME s"`,
    '',
  ].join('\n');
}
