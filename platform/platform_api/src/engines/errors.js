// Traduce la salida de error de terraform/tofu/aws a un mensaje comprensible (RF-11).
// El texto original sigue en los eventos de la operación (ya redactados).
import { redact } from '../lib/redact.js';

const known = [
  [
    /Error acquiring the state lock|ConditionalCheckFailed.*lock|state lock/i,
    'Otra ejecución tiene bloqueado el estado de este tenant. Espera a que termine; si se interrumpió, un responsable debe revisar el bloqueo (force-unlock) antes de reintentar.',
  ],
  [
    /No valid credential sources|NoCredentialProviders|failed to refresh cached credentials|could not load credentials|Unable to locate credentials/i,
    'El worker no tiene credenciales de AWS válidas. Configura AWS_PROFILE o las variables AWS_* del proceso del worker.',
  ],
  [
    /ExpiredToken|token included in the request is expired|RequestExpired/i,
    'Las credenciales de AWS del worker expiraron. Renueva la sesión y reintenta.',
  ],
  [
    /VcpuLimitExceeded|InstanceLimitExceeded|vCPU capacity/i,
    'La cuenta alcanzó la cuota de vCPU de EC2 en la región. Detén tenants de prueba o solicita más cuota.',
  ],
  [
    /InsufficientInstanceCapacity/i,
    'AWS no tiene capacidad para ese tamaño de instancia en la zona. Reintenta más tarde.',
  ],
  [
    /InvalidAMIID|AMI .* not found|no matching EC2 Image|Your query returned no results/i,
    'No se encontraron las AMIs configuradas en la cuenta/región. Revisa infra/packer/ami-ids.json.',
  ],
  [
    /UnauthorizedOperation|AccessDenied|not authorized to perform/i,
    'Las credenciales del worker no tienen permiso para una acción de AWS. Revisa el detalle en los eventos.',
  ],
  [
    /NoSuchBucket|S3 bucket .* does not exist|Failed to get existing workspaces/i,
    'No se pudo acceder al bucket del estado. Revisa IAC_STATE_BUCKET y la región.',
  ],
  [
    /plantilla cloud-init|cloud_init_template_path/i,
    'No se encontró la plantilla cloud-init del módulo. Revisa IAC_CLOUD_INIT_TEMPLATE.',
  ],
  [
    /Failed to query available provider packages|could not connect to registry|dial tcp/i,
    'No se pudo descargar el proveedor de AWS. Revisa la conexión a Internet del worker y reintenta.',
  ],
];

/** Devuelve un mensaje corto y sin secretos a partir de las últimas líneas de stderr. */
export function explainEngineError(lines, label = 'El motor') {
  const text = lines.join('\n');
  for (const [pattern, message] of known) if (pattern.test(text)) return message;
  // Terraform/OpenTofu: "Error: <resumen>" (opcionalmente con el prefijo "│ ").
  const summary = lines
    .map((line) => line.replace(/^[│╷╵\s]+/, ''))
    .find((line) => /^Error: /.test(line));
  if (summary) return redact(`${label}: ${summary.slice(7)}`).slice(0, 400);
  const last = lines.at(-1);
  return last
    ? redact(`${label} falló: ${last}`).slice(0, 400)
    : `${label} terminó con error.`;
}
