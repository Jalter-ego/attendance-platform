// Adaptador CloudFormation (D4/D5, P2). Un stack por tenant y entorno con la plantilla
// infra/cloudformation/tenant.yaml (mismo stack que infra/terraform/tenant).
//
// - Estado: lo administra AWS (el propio stack); no hay archivo de estado ni bloqueo propio.
//   La cola de P6 evita dos operaciones simultáneas del mismo tenant.
// - Vista previa: change sets (qué recursos se agregan, modifican, reemplazan o eliminan).
// - Progreso: los eventos del stack se registran como eventos de la operación.
// - Suspender/reanudar (D5): CloudFormation no detiene instancias de forma declarativa;
//   el adaptador usa la API de EC2 sobre las instancias del stack y conserva los discos.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVpcsCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { OperationError } from '../worker/errors.js';
import { explainEngineError } from './errors.js';
import { engineResult } from './result.js';
import { imageVersions, templatesCommit } from './versions.js';

const require = createRequire(import.meta.url);
const ROLES = ['frontend', 'backend', 'db'];
const LABEL = 'CloudFormation';
const SUCCESS = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'DELETE_COMPLETE']);
const FAILED = new Set([
  'CREATE_FAILED',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
  'IMPORT_ROLLBACK_COMPLETE',
]);
const NO_CHANGES = /didn't contain changes|No updates are to be performed/i;

export function stackName(input) {
  return `${input.base.project_name}-${input.tenant_id}-${input.env}`;
}

/** Identidad para cloud-init (pares JSON sin llaves) que la plantilla completa por rol. */
export function bootIdentity(input, vpcCidr) {
  const backups = input.base.backups_bucket ?? '';
  return JSON.stringify({
    tenant_id: input.tenant_id,
    env: input.env,
    plan: input.plan,
    region: input.base.region,
    ssm_prefix: `/tenants/${input.tenant_id}/${input.env}`,
    vpc_cidr: vpcCidr,
    institution_name: input.name,
    timezone: input.timezone,
    admin_email: input.contact_email,
    limits: input.limits ?? {},
    backup_bucket: backups,
    backup_schedule: input.backup?.schedule ?? '',
    backup_retention_days: input.backup?.retention_days ?? 0,
  }).slice(1, -1);
}

export function stackParameters(input, vpcCidr) {
  const backups = input.base.backups_bucket ?? '';
  const values = {
    ProjectName: input.base.project_name,
    TenantId: input.tenant_id,
    Env: input.env,
    Timezone: input.timezone,
    BootIdentityJson: bootIdentity(input, vpcCidr),
    AvailabilityZone: input.base.availability_zone,
    VpcId: input.base.vpc_id,
    PublicSubnetId: input.base.public_subnet_id,
    PrivateSubnetId: input.base.private_subnet_id,
    MonitoringSecurityGroupId: input.base.monitoring_security_group_id,
    BackupsBucket: backups,
    BackupPolicyTag: backups
      ? `${input.base.project_name}:${input.backup.schedule}-${input.backup.retention_days}d`
      : '',
    FrontendAmi: input.ami.frontend,
    BackendAmi: input.ami.backend,
    DbAmi: input.ami.db,
    FrontendInstanceType: input.sizing.frontend,
    BackendInstanceType: input.sizing.backend,
    DbInstanceType: input.sizing.db,
    DbDiskGb: String(input.sizing.db_disk_gb),
  };
  return Object.entries(values).map(([ParameterKey, ParameterValue]) => ({
    ParameterKey,
    ParameterValue,
  }));
}

export function stackTags(input) {
  return [
    { Key: 'Project', Value: input.base.project_name },
    { Key: 'Tenant', Value: input.tenant_id },
    { Key: 'Env', Value: input.env },
    { Key: 'Plan', Value: input.plan },
    { Key: 'ManagedBy', Value: 'cloudformation' },
  ];
}

/** Resume los cambios de un change set con las mismas claves que plan_preview.py. */
export function summarizeChanges(changes) {
  const totals = { create: 0, update: 0, delete: 0, replace: 0 };
  const lines = [];
  const dataVolumesDeleted = [];
  for (const { ResourceChange: change } of changes) {
    if (!change) continue;
    const replace = change.Replacement === 'True' || change.Replacement === 'Conditional';
    if (change.Action === 'Add') totals.create += 1;
    else if (change.Action === 'Remove') totals.delete += 1;
    else if (change.Action === 'Modify') {
      totals.update += 1;
      if (replace) totals.replace += 1;
    }
    if (
      change.ResourceType === 'AWS::EC2::Volume' &&
      (change.Action === 'Remove' || (change.Action === 'Modify' && replace))
    )
      dataVolumesDeleted.push(change.LogicalResourceId);
    const verb = { Add: 'Crear', Modify: replace ? 'Reemplazar' : 'Modificar', Remove: 'Eliminar' }[
      change.Action
    ] ?? change.Action;
    lines.push(`${verb} ${change.LogicalResourceId} (${change.ResourceType})`);
  }
  return { totals, lines, data_volumes_deleted: dataVolumesDeleted };
}

function outputsMap(stack) {
  return Object.fromEntries((stack?.Outputs ?? []).map((item) => [item.OutputKey, item.OutputValue]));
}

export function createCloudFormationAdapter(config) {
  const pollMs = config.CFN_POLL_MS;

  async function bounded(ctx, operation) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new OperationError(
      'IAC_TIMEOUT', 'CloudFormation alcanzó el tiempo máximo. Revisa el stack en AWS antes de reintentar; la operación remota puede continuar.',
    )), config.IAC_TIMEOUT_S * 1000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal;
    try {
      signal.throwIfAborted();
      return await operation({ ...ctx, signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // config.cfnClient / config.ec2Client solo existen en pruebas (clientes simulados).
  function clients(input) {
    const options = { region: input.base.region, maxAttempts: 3 };
    const cfn = config.cfnClient ?? new CloudFormationClient(options);
    const ec2 = config.ec2Client ?? new EC2Client(options);
    return {
      cfn,
      ec2,
      close() {
        if (!config.cfnClient) cfn.destroy();
        if (!config.ec2Client) ec2.destroy();
      },
    };
  }

  // Errores del SDK → mensaje comprensible; cancelación o pérdida de la operación se propagan.
  async function send(ctx, client, command) {
    ctx.signal?.throwIfAborted();
    try {
      return await client.send(command, { abortSignal: ctx.signal });
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        'ENGINE_FAILED',
        explainEngineError([`Error: ${error.name}: ${error.message}`], LABEL),
      );
    }
  }

  const wait = (ctx) => sleep(pollMs, undefined, { signal: ctx.signal }).catch(() => {
    throw ctx.signal.reason;
  });

  async function getStack(ctx, cfn, name) {
    try {
      const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: name }), {
        abortSignal: ctx.signal,
      });
      return Stacks?.[0] ?? null;
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (/does not exist/i.test(error.message ?? '')) return null;
      throw new OperationError(
        'ENGINE_FAILED',
        explainEngineError([`Error: ${error.name}: ${error.message}`], LABEL),
      );
    }
  }

  // Sigue los eventos del stack hasta un estado final. Devuelve el stack final.
  async function follow(ctx, cfn, stackId, token, { progressFrom = 50, progressTo = 78 } = {}) {
    const seen = new Set();
    const failures = [];
    let progress = progressFrom;
    let terminal;
    for (;;) {
      await wait(ctx);
      const fresh = [];
      let next;
      do {
        const page = await send(ctx, cfn, new DescribeStackEventsCommand({ StackName: stackId, NextToken: next }));
        const events = page.StackEvents ?? [];
        fresh.push(...events.filter((event) => event.ClientRequestToken === token && !seen.has(event.EventId)));
        next = page.NextToken;
        // Las páginas van de nuevas a antiguas. Al alcanzar eventos ya vistos no hace
        // falta recorrer todo el historial del stack en cada sondeo.
        if (events.some((event) => seen.has(event.EventId))) next = undefined;
      } while (next);
      fresh.reverse();
      for (const event of fresh) {
        seen.add(event.EventId);
        if (event.ResourceType === 'AWS::CloudFormation::Stack' && event.LogicalResourceId === stackName(ctx.input) &&
            (SUCCESS.has(event.ResourceStatus) || FAILED.has(event.ResourceStatus)))
          terminal = event.ResourceStatus;
        const reason = event.ResourceStatusReason ? ` — ${event.ResourceStatusReason}` : '';
        if (/_FAILED$/.test(event.ResourceStatus) && !/cancel/i.test(reason))
          failures.push(`${event.LogicalResourceId}: ${event.ResourceStatusReason ?? event.ResourceStatus}`);
        progress = Math.min(progressTo, progress + 1);
        await ctx.report(`${event.LogicalResourceId} (${event.ResourceType}): ${event.ResourceStatus}${reason}`, {
          level: /_FAILED$/.test(event.ResourceStatus) ? 'warning' : 'info',
          progress,
        });
      }
      const stack = await getStack(ctx, cfn, stackId);
      // Un estado COMPLETE anterior puede seguir visible inmediatamente después del
      // request. Solo terminar con el evento raíz del token de ESTA operación.
      if (terminal && SUCCESS.has(terminal) &&
          (stack?.StackStatus === terminal || (!stack && terminal === 'DELETE_COMPLETE'))) return stack;
      if (terminal && FAILED.has(terminal))
        throw new OperationError(
          'ENGINE_FAILED',
          explainEngineError(
            [`Error: ${failures[0] ?? `el stack terminó en ${terminal}`}`],
            LABEL,
          ),
        );
    }
  }

  // Si quedó una operación en curso (p. ej. cancelada en la plataforma), se espera a que
  // AWS la termine antes de seguir: el stack sigue avanzando aunque el worker se detenga.
  async function waitStable(ctx, cfn, stack) {
    if (!stack || !/_IN_PROGRESS$/.test(stack.StackStatus) || stack.StackStatus === 'REVIEW_IN_PROGRESS')
      return stack;
    await ctx.report(`El stack tiene una operación en curso (${stack.StackStatus}); se espera a que termine.`, {
      stage: 'Esperando al stack',
    });
    for (;;) {
      await wait(ctx);
      const current = await getStack(ctx, cfn, stack.StackId);
      if (!current || !/_IN_PROGRESS$/.test(current.StackStatus)) return current;
    }
  }

  async function validateImages(ctx, ec2, input) {
    const { Images = [] } = await send(
      ctx,
      ec2,
      new DescribeImagesCommand({ ImageIds: Object.values(input.ami), Owners: ['self'] }),
    );
    for (const role of ROLES) {
      const image = Images.find((item) => item.ImageId === input.ami[role]);
      const tag = image?.Tags?.find((item) => item.Key === 'Role')?.Value;
      if (!image || image.State !== 'available' || tag !== role)
        throw new OperationError(
          'IAC_INPUT',
          `La AMI de ${role} no está disponible en la cuenta o no tiene la etiqueta Role=${role}. Revisa infra/packer/ami-ids.json.`,
        );
    }
  }

  async function vpcCidr(ctx, ec2, input) {
    const { Vpcs = [] } = await send(ctx, ec2, new DescribeVpcsCommand({ VpcIds: [input.base.vpc_id] }));
    if (!Vpcs[0]?.CidrBlock)
      throw new OperationError('IAC_INPUT', 'No se encontró la VPC de la base. Vuelve a exportar sus outputs.');
    return Vpcs[0].CidrBlock;
  }

  async function changeSet(ctx, cfn, input, cidr, type) {
    const name = `p2-${Date.now()}`;
    const stack = stackName(input);
    const template = await readFile(config.IAC_CFN_TEMPLATE, 'utf8');
    await send(
      ctx,
      cfn,
      new CreateChangeSetCommand({
        StackName: stack,
        ChangeSetName: name,
        ChangeSetType: type,
        TemplateBody: template,
        Parameters: stackParameters(input, cidr),
        Capabilities: ['CAPABILITY_IAM'],
        Tags: stackTags(input),
      }),
    );
    for (;;) {
      await wait(ctx);
      const changes = [];
      let token;
      let result;
      do {
        result = await send(
          ctx,
          cfn,
          new DescribeChangeSetCommand({ StackName: stack, ChangeSetName: name, NextToken: token }),
        );
        changes.push(...(result.Changes ?? []));
        token = result.NextToken;
      } while (token);
      if (result.Status === 'CREATE_COMPLETE') return { name, changes };
      if (result.Status === 'FAILED') {
        if (type === 'UPDATE' && NO_CHANGES.test(result.StatusReason ?? '')) {
          await send(ctx, cfn, new DeleteChangeSetCommand({ StackName: stack, ChangeSetName: name }));
          return { name: null, changes: [] };
        }
        throw new OperationError(
          'ENGINE_FAILED',
          explainEngineError([`Error: ${result.StatusReason ?? 'no se pudo crear el change set'}`], LABEL),
        );
      }
    }
  }

  // Outputs comunes; la IP pública y el estado se consultan en EC2 (cambian al reanudar).
  async function currentOutputs(ctx, ec2, input, stack) {
    const out = outputsMap(stack);
    const ids = {
      frontend: out.FrontendInstanceId,
      backend: out.BackendInstanceId,
      db: out.DbInstanceId,
    };
    if (!ids.frontend) throw new OperationError('ENGINE_OUTPUT', 'El stack no tiene los outputs esperados.');
    const { Reservations = [] } = await send(
      ctx,
      ec2,
      new DescribeInstancesCommand({ InstanceIds: Object.values(ids) }),
    );
    const instances = Reservations.flatMap((reservation) => reservation.Instances ?? []);
    const frontend = instances.find((item) => item.InstanceId === ids.frontend);
    const running = frontend?.State?.Name === 'running';
    const ip = running ? frontend.PublicIpAddress : null;
    const suspended = instances.every((item) => ['stopped', 'stopping'].includes(item.State?.Name));
    return {
      urls: {
        frontend: ip ? `http://${ip}/` : null,
        api: ip ? `http://${ip}/core/api/v1` : null,
        frontend_health: ip ? `http://${ip}/healthz` : null,
        backend_health: ip ? `http://${ip}/core/api/v1/health` : null,
      },
      instance_ids: ids,
      private_ips: { frontend: out.FrontendPrivateIp, backend: out.BackendPrivateIp, db: out.DbPrivateIp },
      db_volume_id: out.DbVolumeId,
      ssm_prefix: out.SsmPrefix,
      suspended,
      stack_name: stackName(input),
      stack_id: stack.StackId,
    };
  }

  async function versions(ctx) {
    let sdk = null;
    try {
      sdk = require('@aws-sdk/client-cloudformation/package.json').version;
    } catch {
      /* sin versión */
    }
    let templateSha = null;
    try {
      templateSha = createHash('sha256')
        .update(await readFile(config.IAC_CFN_TEMPLATE))
        .digest('hex')
        .slice(0, 12);
    } catch {
      /* se informa al leer la plantilla */
    }
    return {
      engine: 'cloudformation',
      cloudformation: 'AWS (administrado)',
      aws_sdk: sdk,
      template_sha256: templateSha,
      templates_commit: await templatesCommit(dirname(config.IAC_CFN_TEMPLATE), ['.']),
      ...imageVersions(ctx.input),
      template: 'infra/cloudformation/tenant.yaml',
    };
  }

  async function apply(ctx) {
    const { input } = ctx;
    const aws = clients(input);
    try {
      await ctx.report(`Motor ${LABEL}. Stack ${stackName(input)}.`, {
        stage: 'Preparando el stack',
        progress: 10,
      });
      await validateImages(ctx, aws.ec2, input);
      const cidr = await vpcCidr(ctx, aws.ec2, input);
      const toolVersions = await versions(ctx);
      let stack = await waitStable(ctx, aws.cfn, await getStack(ctx, aws.cfn, stackName(input)));
      // Una creación fallida deja el stack en ROLLBACK_COMPLETE, sin recursos y sin poder
      // actualizarse: se elimina para que el reintento cree uno nuevo (RF-12).
      if (stack?.StackStatus === 'ROLLBACK_COMPLETE') {
        await ctx.report('La creación anterior falló y AWS revirtió el stack. Se elimina para reintentar.', {
          stage: 'Limpiando el intento anterior',
          progress: 20,
        });
        const token = randomUUID();
        await send(ctx, aws.cfn, new DeleteStackCommand({ StackName: stack.StackId, ClientRequestToken: token }));
        await follow(ctx, aws.cfn, stack.StackId, token, { progressFrom: 20, progressTo: 28 });
        stack = null;
      }
      const type = !stack || stack.StackStatus === 'REVIEW_IN_PROGRESS' ? 'CREATE' : 'UPDATE';
      await ctx.report(
        type === 'CREATE' ? 'Creando el change set del stack nuevo.' : 'Calculando los cambios del stack (change set).',
        { stage: 'Planificando cambios', progress: 30 },
      );
      const plan = await changeSet(ctx, aws.cfn, input, cidr, type);
      const summary = summarizeChanges(plan.changes);
      for (const line of summary.lines) await ctx.report(line);
      if (summary.data_volumes_deleted.length) {
        await send(ctx, aws.cfn, new DeleteChangeSetCommand({ StackName: stackName(input), ChangeSetName: plan.name }));
        throw new OperationError(
          'DATA_LOSS_BLOCKED',
          'El change set eliminaría o reemplazaría el disco de datos de PostgreSQL. Se descartó sin aplicar cambios.',
        );
      }
      await ctx.report(
        `Plan: crear ${summary.totals.create}, modificar ${summary.totals.update}, eliminar ${summary.totals.delete}.`,
        { stage: 'Plan revisado', progress: 45 },
      );
      if (!plan.name) {
        await ctx.report('Sin cambios: el stack ya coincide con lo solicitado.', {
          stage: 'Sin cambios pendientes',
          progress: 75,
        });
      } else {
        await ctx.report('Ejecutando el change set. CloudFormation crea los recursos en orden.', {
          stage: 'Aplicando cambios',
          progress: 50,
        });
        const token = randomUUID();
        await send(
          ctx,
          aws.cfn,
          new ExecuteChangeSetCommand({ StackName: stackName(input), ChangeSetName: plan.name,
            ClientRequestToken: token, DisableRollback: false }),
        );
        stack = await follow(ctx, aws.cfn, stackName(input), token);
      }
      stack = await getStack(ctx, aws.cfn, stackName(input));
      const outputs = await currentOutputs(ctx, aws.ec2, input, stack);
      await ctx.report('Outputs del stack leídos.', { stage: 'Infraestructura aplicada', progress: 80 });
      return { ...engineResult({ outputs, toolVersions, logRef: ctx.logRef }), preview: summary };
    } finally {
      aws.close();
    }
  }

  // D5: detener/arrancar por la API de EC2; los discos EBS y los datos se conservan.
  async function power(ctx, state) {
    const { input } = ctx;
    const aws = clients(input);
    try {
      await ctx.report(
        `${LABEL} no detiene instancias de forma declarativa: se ${state === 'stopped' ? 'detienen' : 'arrancan'} con la API de EC2.`,
        { stage: state === 'stopped' ? 'Deteniendo servidores' : 'Arrancando servidores', progress: 20 },
      );
      const toolVersions = await versions(ctx);
      const stack = await waitStable(ctx, aws.cfn, await getStack(ctx, aws.cfn, stackName(input)));
      if (!stack) throw new OperationError('ENGINE_FAILED', 'El stack del tenant no existe. Créalo primero.');
      const ids = Object.values((await currentOutputs(ctx, aws.ec2, input, stack)).instance_ids);
      await send(
        ctx,
        aws.ec2,
        state === 'stopped'
          ? new StopInstancesCommand({ InstanceIds: ids })
          : new StartInstancesCommand({ InstanceIds: ids }),
      );
      let progress = 30;
      for (;;) {
        await wait(ctx);
        const { Reservations = [] } = await send(ctx, aws.ec2, new DescribeInstancesCommand({ InstanceIds: ids }));
        const states = Reservations.flatMap((item) => item.Instances ?? []).map((item) => item.State?.Name);
        progress = Math.min(75, progress + 5);
        await ctx.report(`Estado de las EC2: ${states.join(', ')}.`, { progress });
        if (states.length === ids.length && states.every((name) => name === state)) break;
      }
      const outputs = await currentOutputs(ctx, aws.ec2, input, stack);
      await ctx.report('Outputs actualizados.', { stage: 'Infraestructura aplicada', progress: 80 });
      return engineResult({ outputs, toolVersions, logRef: ctx.logRef });
    } finally {
      aws.close();
    }
  }

  async function destroy(ctx) {
    const { input } = ctx;
    const aws = clients(input);
    try {
      await ctx.report(`Eliminando el stack ${stackName(input)}: EC2, discos (incluido el de datos), SG e IAM.`, {
        stage: 'Eliminando recursos',
        progress: 20,
      });
      const toolVersions = await versions(ctx);
      const stack = await waitStable(ctx, aws.cfn, await getStack(ctx, aws.cfn, stackName(input)));
      if (stack) {
        const token = randomUUID();
        await send(ctx, aws.cfn, new DeleteStackCommand({ StackName: stack.StackId, ClientRequestToken: token }));
        await follow(ctx, aws.cfn, stack.StackId, token, { progressFrom: 30, progressTo: 78 });
      } else await ctx.report('El stack ya no existía.');
      await ctx.report('Recursos del tenant eliminados.', { stage: 'Recursos eliminados', progress: 80 });
      return engineResult({ outputs: {}, toolVersions, logRef: ctx.logRef });
    } finally {
      aws.close();
    }
  }

  async function preview(ctx, { destroy: forDestroy = false } = {}) {
    const { input } = ctx;
    const aws = clients(input);
    try {
      const stack = await getStack(ctx, aws.cfn, stackName(input));
      if (forDestroy) {
        if (!stack) return { totals: { delete: 0 }, changes: [], data_volumes_deleted: [] };
        const { StackResources = [] } = await send(
          ctx,
          aws.cfn,
          new DescribeStackResourcesCommand({ StackName: stack.StackId }),
        );
        return summarizeChanges(
          StackResources.map((item) => ({
            ResourceChange: { Action: 'Remove', LogicalResourceId: item.LogicalResourceId, ResourceType: item.ResourceType },
          })),
        );
      }
      const cidr = await vpcCidr(ctx, aws.ec2, input);
      const type = !stack || stack.StackStatus === 'REVIEW_IN_PROGRESS' ? 'CREATE' : 'UPDATE';
      const plan = await changeSet(ctx, aws.cfn, input, cidr, type);
      if (plan.name)
        await send(ctx, aws.cfn, new DeleteChangeSetCommand({ StackName: stackName(input), ChangeSetName: plan.name }));
      return summarizeChanges(plan.changes);
    } finally {
      aws.close();
    }
  }

  return {
    engine: 'cloudformation',
    label: LABEL,
    versions,
    async preflight(ctx) {
      ctx.signal?.throwIfAborted();
      try { await readFile(config.IAC_CFN_TEMPLATE, 'utf8'); }
      catch { throw new OperationError('IAC_CONFIG', 'No se pudo leer la plantilla CloudFormation. Revisa IAC_CFN_TEMPLATE.'); }
    },
    preview: (ctx, options) => bounded(ctx, (active) => preview(active, options)),
    apply: (ctx) => bounded(ctx, apply),
    suspend: (ctx) => bounded(ctx, (active) => power(active, 'stopped')),
    resume: (ctx) => bounded(ctx, (active) => power(active, 'running')),
    destroy: (ctx) => bounded(ctx, destroy),
    outputs: (ctx) => bounded(ctx, async (active) => {
      const aws = clients(active.input);
      try {
        const stack = await getStack(active, aws.cfn, stackName(active.input));
        if (!stack) throw new OperationError('ENGINE_FAILED', 'El stack del tenant no existe.');
        return await currentOutputs(active, aws.ec2, active.input, stack);
      } finally {
        aws.close();
      }
    }),
  };
}
