import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { EcsClusterStack } from '../lib/ecs-cluster-stack';
import { ServicesStack } from '../lib/services-stack';
import { EdgeStack } from '../lib/edge-stack';
import { SesStack } from '../lib/ses-stack';
import { AppSecretsStack } from '../lib/app-secrets-stack';
import { buildGraph } from './helpers';

describe('EdgeStack', () => {
  it('creates an internet-facing NLB with TCP listeners on 443 and 80', () => {
    const t = Template.fromStack(buildGraph('staging').edge);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network',
      Scheme: 'internet-facing',
    });
    for (const port of [443, 80]) {
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Protocol: 'TCP',
        Port: port,
      });
    }
  });

  it('restricts nginx edge ingress to Cloudflare ranges when the toggle is on', () => {
    // The nginx SG (and its ingress rules) render in the network stack; the
    // edge stack drives the Cloudflare-vs-internet toggle on that SG.
    const graph = buildGraph('staging');
    const t = Template.fromStack(graph.network);
    // Cloudflare-scoped ingress (not 0.0.0.0/0) on the edge port 8443.
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ FromPort: 8443, CidrIp: '173.245.48.0/20' }),
      ]),
    });
    // No open-internet rule on the edge ports while the toggle is on.
    const sgs = t.findResources('AWS::EC2::SecurityGroup');
    const openInternet = Object.values(sgs).flatMap((sg) =>
      (
        ((sg.Properties as Record<string, unknown>)
          .SecurityGroupIngress as Array<Record<string, unknown>>) ?? []
      ).filter(
        (rule) =>
          rule.CidrIp === '0.0.0.0/0' &&
          [8080, 8443].includes(rule.FromPort as number),
      ),
    );
    expect(openInternet).toHaveLength(0);
  });

  it('opens the edge ports to the internet when the toggle is off', () => {
    // Build a minimal graph with cloudflareIngressEnabled forced off.
    const app = new cdk.App();
    const base = getConfig('staging');
    const config = { ...base, cloudflareIngressEnabled: false };
    const env = { account: '111111111111', region: 'us-east-2' };

    const network = new NetworkStack(app, 'n', { env, config });
    const data = new DataStack(app, 'd', {
      env,
      config,
      vpc: network.vpc,
      isolatedSubnets: network.isolatedSubnets,
      proxySecurityGroup: network.proxySecurityGroup,
    });
    const cluster = new EcsClusterStack(app, 'c', { env, config, vpc: network.vpc });
    const ses = new SesStack(app, 'm', { env, config });
    const secrets = new AppSecretsStack(app, 'x', { env, config });
    const services = new ServicesStack(app, 's', {
      env,
      config,
      computeSubnets: network.computeSubnets,
      cluster: cluster.cluster,
      namespaceName: cluster.namespaceName,
      repositories: cluster.repositories,
      logGroups: cluster.logGroups,
      proxyEndpoint: data.proxyEndpoint,
      loginSecrets: data.loginSecrets,
      computeSubnetCidrs: network.computeSubnetCidrs,
      nginxSecurityGroup: network.nginxSecurityGroup,
      webSecurityGroup: network.webSecurityGroup,
      apiSecurityGroup: network.apiSecurityGroup,
      workersSecurityGroup: network.workersSecurityGroup,
      appSecrets: { ...secrets, smtp: ses.smtpSecret },
    });
    new EdgeStack(app, 'e', {
      env,
      config,
      vpc: network.vpc,
      publicSubnets: network.publicSubnets,
      nginxService: services.services.nginx,
      nginxSecurityGroup: network.nginxSecurityGroup,
      nlbSecurityGroup: network.nlbSecurityGroup,
    });

    // With the toggle off, the nginx SG (in the network stack) opens the edge
    // ports to the internet.
    const t = Template.fromStack(network);
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ FromPort: 8443, CidrIp: '0.0.0.0/0' }),
      ]),
    });
  });

  it('admits Cloudflare ranges on the NLB security group for 80 and 443', () => {
    const t = Template.fromStack(buildGraph('staging').network);
    const nlbSg = Object.values(t.findResources('AWS::EC2::SecurityGroup')).find(
      (sg) =>
        String((sg.Properties as Record<string, unknown>).GroupDescription).startsWith(
          'DAD NLB',
        ),
    );
    const rules = ((nlbSg?.Properties as Record<string, unknown>)
      .SecurityGroupIngress ?? []) as Array<Record<string, unknown>>;
    for (const port of [80, 443]) {
      expect(rules).toContainEqual(
        expect.objectContaining({ FromPort: port, CidrIp: '104.16.0.0/13' }),
      );
      expect(rules).toContainEqual(
        expect.objectContaining({ FromPort: port, CidrIpv6: '2606:4700::/32' }),
      );
    }
    expect(rules.filter((r) => r.CidrIp === '0.0.0.0/0')).toHaveLength(0);
  });

  it('health-checks the nginx targets with TCP on the traffic port, not the loopback-only 8081', () => {
    for (const env of ['staging', 'production'] as const) {
      const t = Template.fromStack(buildGraph(env).edge);
      const groups = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'));
      expect(groups).toHaveLength(2);
      for (const g of groups) {
        expect(g.Properties.HealthCheckProtocol).toBe('TCP');
        expect(g.Properties.HealthCheckPort).toBeUndefined();
        expect(g.Properties.HealthCheckPath).toBeUndefined();
        expect(g.Properties.TargetGroupAttributes).toContainEqual({
          Key: 'deregistration_delay.timeout_seconds',
          Value: '30',
        });
      }
    }
  });

  it('does not open 8081 to anything', () => {
    const t = Template.fromStack(buildGraph('staging').network);
    const rules = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress'));
    expect(rules.filter((r) => r.Properties.FromPort === 8081)).toHaveLength(0);
  });

  it('outputs the NLB DNS name', () => {
    const t = Template.fromStack(buildGraph('staging').edge);
    const outputs = t.findOutputs('*');
    const names = Object.keys(outputs);
    expect(names.some((n) => n.startsWith('NlbDnsName'))).toBe(true);
  });
});
