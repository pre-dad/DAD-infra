import { Template } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';

type Json = Record<string, any>;

const ingressSources = (t: Template, type: string): Json[] =>
  Object.values(t.findResources(type)).map((r: Json) => r.Properties);

describe('interface endpoint access', () => {
  it('production lets every task security group reach the endpoints on 443', () => {
    const g = buildGraph('production');
    const network = Template.fromStack(g.network);
    const data = Template.fromStack(g.data);
    const endpointSgId = Object.keys(network.findResources('AWS::EC2::SecurityGroup')).find((id) =>
      id.startsWith('EndpointSg'),
    )!;

    const inline = ingressSources(network, 'AWS::EC2::SecurityGroupIngress').filter(
      (p) => p.GroupId?.['Fn::GetAtt']?.[0] === endpointSgId && p.FromPort === 443,
    );
    const fromNetwork = inline.map((p) => p.SourceSecurityGroupId['Fn::GetAtt'][0]);
    expect(fromNetwork).toHaveLength(4);

    const bootstrapRules = ingressSources(data, 'AWS::EC2::SecurityGroupIngress').filter(
      (p) => p.FromPort === 443 && p.ToPort === 443,
    );
    expect(bootstrapRules).toHaveLength(1);
    expect(bootstrapRules[0].SourceSecurityGroupId).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^BootstrapSg/), 'GroupId'] });
    expect(JSON.stringify(bootstrapRules[0].GroupId)).toContain('EndpointSg');
  });

  it('staging has no endpoints, so no endpoint ingress for the bootstrap task', () => {
    const data = Template.fromStack(buildGraph('staging').data);
    const rules = ingressSources(data, 'AWS::EC2::SecurityGroupIngress').filter((p) => p.FromPort === 443);
    expect(rules).toHaveLength(0);
  });
});
