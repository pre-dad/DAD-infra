import { Template, Match } from 'aws-cdk-lib/assertions';
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

  it('admits only the NLB group, with no CIDR rule, on the nginx edge ports when the toggle is on', () => {
    const t = Template.fromStack(buildGraph('staging').network);
    const edgeRules = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (r) => [8080, 8443].includes(r.Properties.FromPort),
    );
    expect(edgeRules).toHaveLength(2);
    for (const r of edgeRules) {
      expect(r.Properties.SourceSecurityGroupId).toBeDefined();
      expect(r.Properties.CidrIp).toBeUndefined();
      expect(r.Properties.CidrIpv6).toBeUndefined();
    }
    const inline = Object.values(t.findResources('AWS::EC2::SecurityGroup')).flatMap(
      (sg) => (sg.Properties.SecurityGroupIngress ?? []) as Array<Record<string, unknown>>,
    );
    expect(inline.filter((r) => [8080, 8443].includes(r.FromPort as number))).toHaveLength(0);
  });

  it('opens the edge ports to the internet when the toggle is off', () => {
    const graph = buildGraph('staging', { cloudflareIngressEnabled: false });
    const t = Template.fromStack(graph.network);
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
