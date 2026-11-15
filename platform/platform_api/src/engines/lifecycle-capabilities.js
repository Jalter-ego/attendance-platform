export const supportsTerraformLifecycle = (engine) => engine === 'terraform' || engine === 'tofu';

const cloudFormationOperations = new Set(['create', 'suspend', 'resume', 'preview-delete', 'delete']);

export const supportsRealLifecycle = (engine, type = 'create') =>
  supportsTerraformLifecycle(engine) || (['cloudformation', 'pulumi'].includes(engine) && cloudFormationOperations.has(type));
