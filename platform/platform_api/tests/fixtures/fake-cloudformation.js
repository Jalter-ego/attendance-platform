// Clientes de AWS simulados, compartidos por pruebas unitarias y de integración.
import { stackTags } from '../../src/engines/cloudformation.js';

const notFound = (name) =>
  Object.assign(new Error(`Stack with id ${name} does not exist`), { name: 'ValidationError' });

/**
 * AWS simulado. `scenario`:
 *  - changes: cambios del change set; FAILED sin cambios si es [] en UPDATE.
 *  - executeResult: estado final al ejecutar (CREATE_COMPLETE, ROLLBACK_COMPLETE...).
 *  - failReason: motivo del evento *_FAILED.
 *  - existing: estado inicial del stack (null = no existe).
 *  - roleTag: etiqueta Role de la AMI de db (para probar la validación).
 */
export function fakeCloudFormation(input, scenario = {}) {
  const calls = [];
  const instances = {
    'i-11111111111111111': { state: 'running', ip: '198.51.100.40' },
    'i-22222222222222222': { state: 'running' },
    'i-33333333333333333': { state: 'running' },
  };
  const stackArn = `arn:aws:cloudformation:${input.region}:123456789012:stack/${input.base.project_name}-${input.tenant_id}-${input.env}/11111111-1111-4111-8111-111111111111`;
  let token;
  let stalePolls = scenario.staleStablePolls ?? 0;
  let stack = scenario.existing
    ? { StackId: stackArn, StackStatus: scenario.existing, Outputs: [], Tags: stackTags(input) }
    : null;
  let volumeId = 'vol-44444444444444444';
  let events = [];
  const outputs = [
    ['FrontendInstanceId', 'i-11111111111111111'],
    ['BackendInstanceId', 'i-22222222222222222'],
    ['DbInstanceId', 'i-33333333333333333'],
    ['FrontendPrivateIp', '10.0.1.10'],
    ['BackendPrivateIp', '10.0.2.10'],
    ['DbPrivateIp', '10.0.2.20'],
    ['FrontendPublicIp', '198.51.100.40'],
    ['DbVolumeId', 'vol-44444444444444444'],
    ['SsmPrefix', `/tenants/${input.tenant_id}/${input.env}`],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
  const event = (logical, status, reason) => ({
    ClientRequestToken: token,
    EventId: `${logical}-${status}-${events.length}`,
    Timestamp: new Date(Date.now() + 1000),
    LogicalResourceId: logical,
    ResourceType: 'AWS::EC2::Instance',
    ResourceStatus: status,
    ResourceStatusReason: reason,
  });
  const cfn = {
    async send(command) {
      const name = command.constructor.name;
      const params = command.input;
      calls.push({ name, params });
      switch (name) {
        case 'DescribeStacksCommand':
          if (!stack) throw notFound(params.StackName);
          if (stack.StackStatus === 'DELETE_COMPLETE' && params.StackName !== stack.StackId)
            throw notFound(params.StackName);
          return { Stacks: [stack] };
        case 'CreateChangeSetCommand':
          if (params.ChangeSetType === 'CREATE')
            stack = { StackId: stackArn, StackStatus: 'REVIEW_IN_PROGRESS', Outputs: [], Tags: params.Tags };
          return { Id: 'cs-1' };
        case 'DescribeChangeSetCommand': {
          if (scenario.stuckChangeSet) return { Status: 'CREATE_IN_PROGRESS' };
          const changes = scenario.changes ?? [];
          if (!changes.length && stack.StackStatus !== 'REVIEW_IN_PROGRESS')
            return { Status: 'FAILED', StatusReason: "The submitted information didn't contain changes." };
          return { Status: 'CREATE_COMPLETE', Changes: changes };
        }
        case 'ExecuteChangeSetCommand': {
          token = params.ClientRequestToken;
          const final = scenario.executeResult ?? 'CREATE_COMPLETE';
          events = [
            event('DbInstance', 'CREATE_IN_PROGRESS'),
            { ...event(`${input.base.project_name}-${input.tenant_id}-${input.env}`, final), ResourceType: 'AWS::CloudFormation::Stack' },
            ...(final.includes('ROLLBACK')
              ? [event('DbInstance', 'CREATE_FAILED', scenario.failReason), event('FrontendInstance', 'CREATE_FAILED', 'Resource creation cancelled')]
              : [event('DbInstance', 'CREATE_COMPLETE')]),
          ].reverse();
          stack = { ...stack, StackStatus: final, Outputs: final.includes('ROLLBACK') ? [] : outputs };
          return {};
        }
        case 'DescribeStackEventsCommand':
          if (stalePolls-- > 0) return { StackEvents: [{ ...event('previous', 'UPDATE_COMPLETE'), ResourceType: 'AWS::CloudFormation::Stack', ClientRequestToken: 'previous-operation' }] };
          return { StackEvents: events };
        case 'DeleteChangeSetCommand':
          return {};
        case 'DeleteStackCommand':
          token = params.ClientRequestToken;
          stack = { ...stack, StackStatus: 'DELETE_COMPLETE' };
          events = [event('DbVolume', 'DELETE_COMPLETE'),
            { ...event(`${input.base.project_name}-${input.tenant_id}-${input.env}`, 'DELETE_COMPLETE'), ResourceType: 'AWS::CloudFormation::Stack' }];
          return {};
        case 'DescribeStackResourcesCommand':
          return {
            StackResources: [
              { LogicalResourceId: 'DbInstance', ResourceType: 'AWS::EC2::Instance' },
              { LogicalResourceId: 'DbVolume', ResourceType: 'AWS::EC2::Volume' },
            ],
          };
        case 'ListStackResourcesCommand':
          return params.NextToken
            ? { StackResourceSummaries: [{ LogicalResourceId: 'DbVolume', PhysicalResourceId: volumeId, ResourceType: 'AWS::EC2::Volume' }] }
            : { StackResourceSummaries: [{ LogicalResourceId: 'DbInstance', PhysicalResourceId: 'i-33333333333333333', ResourceType: 'AWS::EC2::Instance' }], NextToken: 'next-page' };
        default:
          throw new Error(`cfn simulado: ${name}`);
      }
    },
  };
  const ec2 = {
    async send(command) {
      const name = command.constructor.name;
      const params = command.input;
      calls.push({ name, params });
      switch (name) {
        case 'DescribeImagesCommand':
          return {
            Images: Object.entries(input.ami).map(([role, id]) => ({
              ImageId: id,
              State: 'available',
              Tags: [{ Key: 'Role', Value: role === 'db' ? (scenario.roleTag ?? 'db') : role }],
            })),
          };
        case 'DescribeVpcsCommand':
          return { Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.20.0.0/16' }] };
        case 'DescribeInstancesCommand':
          return {
            Reservations: [
              {
                Instances: params.InstanceIds.map((id) => ({
                  InstanceId: id,
                  State: { Name: instances[id].state },
                  PublicIpAddress: instances[id].state === 'running' ? instances[id].ip : undefined,
                })),
              },
            ],
          };
        case 'StopInstancesCommand':
          for (const id of params.InstanceIds) instances[id].state = 'stopped';
          return {};
        case 'StartInstancesCommand':
          for (const id of params.InstanceIds) instances[id].state = 'running';
          instances['i-11111111111111111'].ip = '198.51.100.41';
          return {};
        default:
          throw new Error(`ec2 simulado: ${name}`);
      }
    },
  };
  return { cfn, ec2, calls, outputs, stackArn, setStack: (value) => (stack = value), setVolumeId: (value) => (volumeId = value) };
}
