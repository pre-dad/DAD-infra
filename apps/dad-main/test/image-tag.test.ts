import { Template } from 'aws-cdk-lib/assertions';
import { imageTagParameterName } from '../lib/image-tag';
import { buildGraph } from './helpers';

type Resource = { Type: string; Properties: Record<string, any> };

/** The logical id of the stack parameter that reads the given SSM parameter. */
function parameterFor(template: Template, name: string): string {
  const params = (template.toJSON().Parameters ?? {}) as Record<
    string,
    { Type: string; Default?: string }
  >;
  const ids = Object.entries(params)
    .filter(([, p]) => p.Type === 'AWS::SSM::Parameter::Value<String>' && p.Default === name)
    .map(([id]) => id);
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe('image tag from SSM', () => {
  it('names the parameter per environment', () => {
    expect(imageTagParameterName('staging')).toBe('/dad/staging/image-tag');
    expect(imageTagParameterName('production')).toBe('/dad/production/image-tag');
  });

  // The parameter holds the tag of the last release the pipeline deployed. Every task
  // definition must be tagged from it, so a `cdk deploy` that changes one cannot point a
  // service back at a placeholder image that was never pushed.
  describe.each(['staging', 'production'] as const)('%s', (env) => {
    const stacks = (g: ReturnType<typeof buildGraph>) =>
      [
        ['services', g.services],
        ['maintenance', g.maintenance],
      ] as const;

    it.each(['services', 'maintenance'] as const)(
      '%s: every container image is tagged from the SSM parameter, never "latest"',
      (which) => {
        const g = buildGraph(env);
        const stack = which === 'services' ? g.services : g.maintenance;
        const t = Template.fromStack(stack);
        const paramId = parameterFor(t, `/dad/${env}/image-tag`);
        const defs = Object.values(
          t.findResources('AWS::ECS::TaskDefinition') as Record<string, Resource>,
        );
        expect(defs.length).toBeGreaterThan(0);
        for (const def of defs) {
          // The owner bootstrap runs a stock PostgreSQL client image, not a DAD image;
          // it is pinned by digest instead (db-bootstrap.test.ts).
          if (def.Properties.Family === 'dad-maint-bootstrap-owner') continue;
          for (const container of def.Properties.ContainerDefinitions) {
            // Image is { Fn::Join: ['', [<repository uri>..., ':', { Ref: <tag parameter> }]] }.
            const parts: unknown[] = container.Image['Fn::Join'][1];
            expect([def.Properties.Family, parts.slice(-2)]).toEqual([
              def.Properties.Family,
              [':', { Ref: paramId }],
            ]);
            expect(JSON.stringify(container.Image)).not.toContain('latest');
          }
        }
      },
    );

    it('both stacks read the same parameter name', () => {
      const names = stacks(buildGraph(env)).map(([, stack]) => {
        const params = Template.fromStack(stack).toJSON().Parameters as Record<string, { Default?: string }>;
        return Object.values(params)
          .map((p) => p.Default)
          .filter((d) => d?.endsWith('/image-tag'));
      });
      expect(names).toEqual([[`/dad/${env}/image-tag`], [`/dad/${env}/image-tag`]]);
    });
  });

  it('does not create the parameter, so CloudFormation can never overwrite the pipeline\'s value', () => {
    const g = buildGraph('staging');
    for (const stack of [g.services, g.maintenance]) {
      expect(Template.fromStack(stack).findResources('AWS::SSM::Parameter')).toEqual({});
    }
  });
});
