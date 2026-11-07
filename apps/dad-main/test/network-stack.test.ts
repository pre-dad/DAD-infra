import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EnvConfig, getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';

function synth(env: 'staging' | 'production', overrides: Partial<EnvConfig> = {}): Template {
  const app = new cdk.App();
  const config = { ...getConfig(env), ...overrides };
  const stack = new NetworkStack(app, `dad-network-${env}`, {
    env: { account: '111111111111', region: 'us-east-2' },
    config,
  });
  return Template.fromStack(stack);
}

describe('NetworkStack', () => {
  it('creates a VPC with three subnet tiers across 2 AZs', () => {
    const t = synth('staging');
    t.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs x 3 tiers = 6 subnets.
    t.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('asserts the SG chain ingress rules (ports 8080/8443/3000/8002/5432)', () => {
    const t = synth('staging');
    for (const port of [8080, 8443, 3000, 8002, 5432]) {
      t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
      });
    }
  });

  it('gives workers an SG with no inbound rules', () => {
    const t = synth('staging');
    // The workers SG is referenced as a source for the proxy ingress but never
    // appears as the GroupId of an ingress rule itself.
    const ingress = t.findResources('AWS::EC2::SecurityGroupIngress');
    const workerDesc = Object.values(ingress).filter((r) =>
      JSON.stringify(r).includes('no inbound'),
    );
    expect(workerDesc).toHaveLength(0);
  });

  it('production provisions two NAT gateways for AZ redundancy', () => {
    const t = synth('production');
    t.resourceCountIs('AWS::EC2::NatGateway', 2);
  });

  it('publishes the named outputs the app pipeline resolves (ComputeSubnetIds, WorkersSecurityGroupId)', () => {
    // deploy.yml reads these exact OutputKeys off dad-network-<env> to wire the
    // migrate / provision-roles ECS run-tasks (compute subnets + workers SG).
    const t = synth('staging');
    const outputs = t.findOutputs('*');
    expect(outputs).toHaveProperty('ComputeSubnetIds');
    expect(outputs).toHaveProperty('WorkersSecurityGroupId');
  });

  describe('VPC endpoints', () => {
    const serviceNames = (t: Template): string[] =>
      Object.values(t.findResources('AWS::EC2::VPCEndpoint'))
        .map((r) => JSON.stringify(r.Properties.ServiceName))
        .sort();

    it('always creates the free S3 gateway endpoint on the compute route tables only', () => {
      for (const [env, overrides] of [
        ['staging', {}],
        ['production', {}],
        ['production', { interfaceEndpointsEnabled: false }],
      ] as const) {
        const t = synth(env, overrides);
        const gateways = Object.values(t.findResources('AWS::EC2::VPCEndpoint')).filter(
          (r) => r.Properties.VpcEndpointType === 'Gateway',
        );
        expect(gateways).toHaveLength(1);
        expect(JSON.stringify(gateways[0].Properties.ServiceName)).toContain('.s3');
        // One compute route table per AZ, nothing from the public or isolated tiers.
        expect(gateways[0].Properties.RouteTableIds).toHaveLength(2);
        for (const id of gateways[0].Properties.RouteTableIds) {
          expect(JSON.stringify(id)).toContain('computeSubnet');
        }
      }
    });

    it('production has interface endpoints for ECR api+dkr, Secrets Manager and Logs in the compute subnets', () => {
      const t = synth('production');
      const interfaces = Object.values(t.findResources('AWS::EC2::VPCEndpoint')).filter(
        (r) => r.Properties.VpcEndpointType === 'Interface',
      );
      expect(interfaces).toHaveLength(4);
      const names = interfaces.map((r) => JSON.stringify(r.Properties.ServiceName)).join(' ');
      for (const svc of ['ecr.api', 'ecr.dkr', 'secretsmanager', 'logs']) {
        expect(names).toContain(svc);
      }
      for (const r of interfaces) {
        expect(r.Properties.PrivateDnsEnabled).toBe(true);
        expect(r.Properties.SubnetIds).toHaveLength(2);
        for (const id of r.Properties.SubnetIds) {
          expect(JSON.stringify(id)).toContain('computeSubnet');
        }
      }
    });

    it('staging leaves the interface endpoints off by default and they can be switched on', () => {
      expect(serviceNames(synth('staging'))).toHaveLength(1);
      const on = synth('staging', { interfaceEndpointsEnabled: true });
      expect(serviceNames(on)).toHaveLength(5);
    });

    it('switching the interface endpoints off removes them and their security group', () => {
      const t = synth('production', { interfaceEndpointsEnabled: false });
      expect(serviceNames(t)).toHaveLength(1);
      expect(JSON.stringify(t.toJSON())).not.toContain('interface VPC endpoints');
    });

    it('the endpoint security group admits only 443, only from the four compute-tier groups', () => {
      const t = synth('production');
      const sgs = Object.entries(t.findResources('AWS::EC2::SecurityGroup')).filter(([, r]) =>
        String(r.Properties.GroupDescription).includes('interface VPC endpoints'),
      );
      expect(sgs).toHaveLength(1);
      const [sgId, sg] = sgs[0];
      expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
      const rules = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter(
        (r) => r.Properties.GroupId?.['Fn::GetAtt']?.[0] === sgId,
      );
      expect(rules).toHaveLength(4);
      const sources: string[] = [];
      for (const r of rules) {
        expect(r.Properties.IpProtocol).toBe('tcp');
        expect(r.Properties.FromPort).toBe(443);
        expect(r.Properties.ToPort).toBe(443);
        expect(r.Properties.CidrIp).toBeUndefined();
        sources.push(r.Properties.SourceSecurityGroupId['Fn::GetAtt'][0]);
      }
      expect(sources.sort().map((x) => x.replace(/[0-9A-F]{8}$/, ''))).toEqual([
        'ApiSg',
        'NginxSg',
        'WebSg',
        'WorkersSg',
      ]);
    });
  });

  describe('VPC flow logs', () => {
    it.each([
      ['staging', 30, 'REJECT'],
      ['production', 365, 'ALL'],
    ] as const)('%s: logs %i days of retention, %s traffic to CloudWatch', (env, days, traffic) => {
      const t = synth(env);
      t.hasResourceProperties('AWS::EC2::FlowLog', {
        ResourceType: 'VPC',
        TrafficType: traffic,
        LogDestinationType: 'cloud-watch-logs',
      });
      t.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/dad/${env}/vpc-flow-logs`,
        RetentionInDays: days,
      });
    });

    it('retention follows config', () => {
      const t = synth('staging', { flowLogRetentionDays: 90 });
      t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    });
  });
});
