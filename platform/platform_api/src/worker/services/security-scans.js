import { fileURLToPath } from 'node:url';
import { runScanSuite } from '../../../../../observability/scanners/suite.mjs';
import { LeaseLost } from '../errors.js';
import { runCommand } from './command-runner.js';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));

export async function scanBeforeCreate({ pool, config, operation, workerId, report, signal }) {
  await report('Revisando IaC, dependencias y secretos.', { stage: 'Escaneando seguridad', progress: 10 });
  await runScanSuite({
    runCommand,
    repo,
    coreRef: config.PLATFORM_SCAN_CORE_REF,
    signal,
    onResult: async ({ scanner, target, status, count, findings }) => {
      signal.throwIfAborted();
      const result = await pool.query(
        `INSERT INTO platform_scans(tenant_id,scanner,status,findings,operation_id,target,finding_count)
         SELECT tenant_id,$3,$4,$5::jsonb,id,$6,$7 FROM operations
         WHERE id=$1 AND worker_id=$2 AND status='running' AND NOT cancel_requested
         ON CONFLICT (operation_id,scanner) DO UPDATE SET
           status=EXCLUDED.status, findings=EXCLUDED.findings, target=EXCLUDED.target,
           finding_count=EXCLUDED.finding_count`,
        [operation.id, workerId, scanner, status, JSON.stringify(findings), target, count],
      );
      if (!result.rowCount) throw new LeaseLost();
      const message = status === 'error' ? 'no pudo completar el análisis.' : `${count} hallazgos registrados.`;
      await report(`${scanner}: ${message}`, { stage: 'Escaneando seguridad' });
    },
  });
}
