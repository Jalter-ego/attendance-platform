import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const roles = ['frontend', 'backend', 'db'];
const jobs = [
  { name: 'node', port: 9100, roles },
  { name: 'process', port: 9256, roles },
  { name: 'otel', port: 8889, roles },
  { name: 'netdata', port: 19999, roles, path: '/api/v1/allmetrics', params: { format: ['prometheus'] } },
  { name: 'attendance-core', port: 5000, roles: ['backend'], path: '/core/api/v1/metrics' },
];

function ec2Targets(job, { region, vpc, project }) {
  return {
    ec2_sd_configs: [{
      region,
      port: job.port,
      refresh_interval: '30s',
      filters: [
        { name: 'vpc-id', values: [vpc] },
        { name: 'tag:Project', values: [project] },
        { name: 'tag:Role', values: job.roles },
        { name: 'tag:Env', values: ['test', 'prod'] },
        { name: 'instance-state-name', values: ['running'] },
      ],
    }],
    relabel_configs: [
      { source_labels: ['__meta_ec2_tag_Tenant'], regex: '[a-z0-9][a-z0-9-]{1,38}[a-z0-9]', action: 'keep' },
      ...[['tag_Tenant', 'tenant'], ['tag_Env', 'env'], ['tag_Role', 'role'], ['instance_id', 'instance_id']]
        .map(([source, target]) => ({ source_labels: [`__meta_ec2_${source}`], target_label: target })),
    ],
  };
}

function demoTargets(job) {
  return {
    static_configs: ['demo-a', 'demo-b'].flatMap((tenant) => job.roles.map((role) => ({
      targets: [`${tenant}:${job.port}`],
      labels: { tenant, env: 'test', role, instance: `${tenant}-${role}` },
    }))),
  };
}

const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    region: { type: 'string' },
    vpc: { type: 'string' },
    project: { type: 'string', default: 'attendance-platform' },
    out: { type: 'string' },
  },
});

const aws = values.mode === 'aws';
if ((!aws && values.mode !== 'local') || (aws && (!values.region || !/^vpc-[a-f0-9]+$/.test(values.vpc ?? '')))) {
  throw new Error('Uso: node config.mjs --mode local|aws [--region REGION --vpc VPC_ID] [--project PROYECTO] [--out ARCHIVO]');
}

const config = {
  global: { scrape_interval: aws ? '30s' : '5s', scrape_timeout: aws ? '10s' : '4s' },
  scrape_configs: [
    { job_name: 'prometheus', static_configs: [{ targets: ['127.0.0.1:9090'] }] },
    ...jobs.map((job) => ({
      job_name: job.name,
      ...(job.path && { metrics_path: job.path }),
      ...(job.params && { params: job.params }),
      ...(aws ? ec2Targets(job, values) : demoTargets(job)),
    })),
  ],
};

const output = JSON.stringify(config, null, 2) + '\n';
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, output, 'utf8');
} else {
  process.stdout.write(output);
}
