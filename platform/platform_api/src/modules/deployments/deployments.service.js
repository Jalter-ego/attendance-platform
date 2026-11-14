import { randomUUID } from 'node:crypto';
import { transaction } from '../../db/pool.js';
import { LeaseLost } from '../../worker/errors.js';

export async function saveDeployment(pool, operation, workerId, deployment) {
  return transaction(pool, async (client) => {
    const owner = await client.query(
      "SELECT id FROM operations WHERE id = $1 AND worker_id = $2 AND status = 'running' FOR UPDATE",
      [operation.id, workerId],
    );
    if (!owner.rowCount) throw new LeaseLost();
    const result = await client.query(
      `INSERT INTO deployments(id, tenant_id, operation_id, engine, ami, outputs, resources, tool_versions, status, log_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'provisioning',$9)
       ON CONFLICT (operation_id) DO UPDATE SET outputs=EXCLUDED.outputs, resources=EXCLUDED.resources, tool_versions=EXCLUDED.tool_versions
       RETURNING id`,
      [randomUUID(), operation.tenant_id, operation.id, deployment.engine,
        deployment.ami, deployment.outputs, JSON.stringify(deployment.resources), deployment.tool_versions, `operations/${operation.id}`],
    );
    return result.rows[0].id;
  });
}

export async function finishCreation(client, operation, status) {
  const deploymentStatus = status === 'succeeded' ? 'ready' : 'failed';
  await client.query('UPDATE deployments SET status = $2 WHERE operation_id = $1', [operation.id, deploymentStatus]);
  await client.query('UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1', [operation.tenant_id, deploymentStatus]);
}

// PR26 podía dejar estados provisionales al encolar antes de un reinicio del worker.
export async function recoverLegacyTransition(client, operation) {
  const releases = { suspend: ['suspending', 'ready'], resume: ['resuming', 'suspended'], destroy: ['deleting', 'failed'] };
  const state = releases[operation.type];
  if (!state) return;
  await client.query('UPDATE tenants SET status=$3, updated_at=now() WHERE id=$1 AND status=$2',
    [operation.tenant_id, ...state]);
}
