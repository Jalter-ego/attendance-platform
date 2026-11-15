export const supportsTerraformLifecycle = (engine) => engine === 'terraform' || engine === 'tofu';

// CloudFormation y Pulumi (P2): crear, suspender, reanudar y eliminar con vista previa.
const stackOperations = new Set(['create', 'suspend', 'resume', 'preview-delete', 'delete']);

export const supportsRealLifecycle = (engine, type = 'create') =>
  supportsTerraformLifecycle(engine) || (['cloudformation', 'pulumi'].includes(engine) && stackOperations.has(type));
