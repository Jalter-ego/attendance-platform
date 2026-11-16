import { createServer } from 'node:http';

const backend = '/core/api/v1';
const started = Date.now();
let forcedErrors = 0;

function metrics(port) {
  const elapsed = Math.floor((Date.now() - started) / 1000);
  const route = `${backend}/demo/error`;
  const ok = `{method="GET",route="${route}",status="200"}`;
  const error = `{method="GET",route="${route}",status="500"}`;
  if (port === 5000) return [
    `http_requests_total${ok} ${elapsed}`,
    `http_requests_total${error} ${forcedErrors}`,
    ...['0.1', '0.25', '0.5', '+Inf'].map((bucket) =>
      `http_request_duration_seconds_bucket{method="GET",route="${route}",status="200",le="${bucket}"} ${elapsed}`),
    'nodejs_eventloop_lag_seconds 0.004',
    'nodejs_heap_size_used_bytes 28000000',
  ];
  if (port === 9100) return [
    `node_cpu_seconds_total{cpu="0",mode="idle"} ${elapsed * 0.7}`,
    'node_memory_MemAvailable_bytes 500000000',
    'node_memory_MemTotal_bytes 1000000000',
    'node_filesystem_avail_bytes{mountpoint="/",fstype="ext4"} 6000000000',
    'node_filesystem_size_bytes{mountpoint="/",fstype="ext4"} 10000000000',
    'node_filesystem_avail_bytes{mountpoint="/var/lib/postgresql",fstype="ext4"} 8000000000',
    'node_filesystem_size_bytes{mountpoint="/var/lib/postgresql",fstype="ext4"} 10000000000',
  ];
  if (port === 9256) return ['namedprocess_namegroup_num_procs{groupname="postgres"} 1'];
  if (port === 8889) return ['system_memory_usage_bytes{state="used"} 500000000'];
  return ['netdata_system_cpu_percentage_average{dimension="user"} 18'];
}

for (const port of [5000, 9100, 9256, 8889, 19999]) {
  createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (port === 5000 && path === `${backend}/demo/error`) {
      forcedErrors += 1;
      res.writeHead(500).end('Error simulado\n');
      return;
    }
    const metricsPath = port === 5000 ? `${backend}/metrics` : port === 19999 ? '/api/v1/allmetrics' : '/metrics';
    if (path !== metricsPath) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(`${metrics(port).join('\n')}\n`);
  }).listen(port, '0.0.0.0');
}
