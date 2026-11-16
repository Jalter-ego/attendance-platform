import assert from 'node:assert/strict';
import test from 'node:test';
import { receiveAlerts } from '../src/modules/observability.js';
import { scanFindings } from '../../../observability/scanners/suite.mjs';

test('el webhook traduce alertas firing con identidad de tenant y una clave estable de reenvío', async () => {
  const sample = {
    status: 'firing',
    labels: { tenant: 'demo-a', env: 'test', severity: 'critical' },
    annotations: { summary: 'Backend caído' },
    fingerprint: 'a0123456789bcdef',
    startsAt: '2026-11-15T10:30:00-03:00',
  };
  const pool = {
    async query(sql, [data]) {
      assert.match(sql, /JOIN tenants t ON t.tenant_id=e.tenant_id AND t.env=e.env/);
      assert.match(sql, /ON CONFLICT \(tenant_id, source_event\) DO NOTHING/);
      assert.deepEqual(JSON.parse(data), [{
        tenant_id: 'demo-a',
        env: 'test',
        severity: 'critical',
        message: 'Backend caído',
        detected_at: sample.startsAt,
        source_event: 'grafana:a0123456789bcdef:2026-11-15T13:30:00.000Z',
      }]);
      return { rowCount: 1 };
    },
  };
  assert.deepEqual(await receiveAlerts(pool, { alerts: [
    sample, { ...sample, status: 'resolved' }, { ...sample, labels: {} },
  ] }), { received: 1 });
});

test('los informes de seguridad se reducen a campos permitidos', () => {
  assert.deepEqual(scanFindings('Gitleaks', [{
    File: '/scan/infra/example.tf', RuleID: 'example-rule', StartLine: 3, Secret: 'VALOR_PRIVADO', Match: 'VALOR_PRIVADO',
  }]), ['example-rule · infra/example.tf:3']);
  assert.deepEqual(scanFindings('Checkov', { results: { failed_checks: [{
    check_id: 'CKV_AWS_1', file_path: '/scan/infra/example.tf', resource: 'example', code_block: ['VALOR_PRIVADO'],
  }] } }), ['CKV_AWS_1 · infra/example.tf · example']);
  assert.deepEqual(scanFindings('Trivy', { Results: [{ Type: 'pnpm', Target: 'pnpm-lock.yaml' }] }), []);
  assert.throws(() => scanFindings('Trivy', {}), /no reconoció pnpm-lock/);
});
