// Salida común de los adaptadores (docs/contratos-integracion.md).

/** Recursos visibles del tenant a partir de los outputs comunes. */
export function resourcesFromOutputs(outputs) {
  const resources = Object.entries(outputs.instance_ids ?? {}).map(
    ([role, id]) => ({ type: 'aws_instance', role, id }),
  );
  if (outputs.db_volume_id)
    resources.push({ type: 'aws_ebs_volume', role: 'db', id: outputs.db_volume_id });
  return resources;
}

/** @returns {EngineResult} */
export function engineResult({ outputs = {}, toolVersions = {}, logRef }) {
  return {
    status: 'succeeded',
    resources: resourcesFromOutputs(outputs),
    outputs: {
      ...outputs,
      urls: outputs.urls ?? {},
      instance_ids: outputs.instance_ids ?? {},
      private_ips: outputs.private_ips ?? {},
    },
    tool_versions: toolVersions,
    log_ref: logRef,
  };
}
