import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';

describe('ServicesStack', () => {
  it.each(['staging', 'production'] as const)(
    '%s: ECR pull is on the execution roles only, never a task role',
    (env) => {
      const t = Template.fromStack(buildGraph(env).services);
      const roleIds = (prop: 'TaskRoleArn' | 'ExecutionRoleArn') =>
        new Set(
          Object.values(t.findResources('AWS::ECS::TaskDefinition')).map(
            (td) => td.Properties[prop]['Fn::GetAtt'][0] as string,
          ),
        );
      const taskRoles = roleIds('TaskRoleArn');
      const executionRoles = roleIds('ExecutionRoleArn');
      const pullers = new Set<string>();
      for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
        const pulls = JSON.stringify(policy.Properties.PolicyDocument).includes(
          'ecr:BatchGetImage',
        );
        if (pulls) {
          for (const role of policy.Properties.Roles as Array<{ Ref: string }>) {
            pullers.add(role.Ref);
          }
        }
      }
      expect(taskRoles.size).toBeGreaterThan(0);
      expect([...taskRoles].filter((r) => pullers.has(r))).toEqual([]);
      expect([...executionRoles].every((r) => pullers.has(r))).toBe(true);
    },
  );

  it('creates exactly 9 ECS services', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    t.resourceCountIs('AWS::ECS::Service', 9);
  });

  it('defines the six worker commands as `worker --kind <kind>`', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    const expected = [
      'stripe',
      'projections',
      'login-email',
      'email-changes',
      'messages',
      'push',
    ];
    for (const kind of expected) {
      t.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Command: ['worker', '--kind', kind],
          }),
        ]),
      });
    }
  });

  it('exposes container ports 8002 (api), 3000 (web), 8443 (nginx)', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    for (const port of [8002, 3000, 8443]) {
      t.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            PortMappings: Match.arrayWith([
              Match.objectLike({ ContainerPort: port }),
            ]),
          }),
        ]),
      });
    }
  });

  it('sets DONOR_API_BASE_URL=http://api:8002 on the web service', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            {
              Name: 'DONOR_API_BASE_URL',
              Value: 'http://api:8002',
            },
          ]),
        }),
      ]),
    });
  });

  // ECS ignores a Dockerfile HEALTHCHECK, and deploy.yml gates on the rollout reaching
  // COMPLETED, so each HTTP service must declare its own container health check.
  describe('rollout health gate', () => {
    /** The container health check of the task definition with this family. */
    const healthCheckOf = (family: string): unknown => {
      const t = Template.fromStack(buildGraph('staging').services);
      const defs = t.findResources('AWS::ECS::TaskDefinition', {
        Properties: { Family: family },
      });
      const ids = Object.keys(defs);
      expect(ids).toHaveLength(1);
      const containers = defs[ids[0]].Properties.ContainerDefinitions;
      expect(containers).toHaveLength(1);
      return containers[0].HealthCheck;
    };

    it('api probes /health/live on 8002 (liveness, not DB-backed readiness)', () => {
      const hc = healthCheckOf('dad-api') as { Command: string[] };
      expect(hc.Command).toEqual([
        'CMD',
        'wget',
        '-q',
        '-O',
        '/dev/null',
        'http://127.0.0.1:8002/health/live',
      ]);
      expect(hc.Command.join(' ')).not.toContain('/health/ready');
    });

    it('nginx probes /health on 8081', () => {
      const hc = healthCheckOf('dad-nginx') as { Command: string[] };
      expect(hc.Command).toEqual([
        'CMD',
        'wget',
        '-q',
        '-O',
        '/dev/null',
        'http://127.0.0.1:8081/health',
      ]);
    });

    it('web probes / on 3000 and treats status >= 500 or a connection error as unhealthy', () => {
      const hc = healthCheckOf('dad-web') as { Command: string[] };
      expect(hc.Command.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
      expect(hc.Command[3]).toContain('http://127.0.0.1:3000/');
      expect(hc.Command[3]).toContain('r.statusCode<500');
    });

    it('gives the HTTP services a start period so a slow boot is not counted as failure', () => {
      for (const family of ['dad-api', 'dad-web', 'dad-nginx']) {
        const hc = healthCheckOf(family) as { StartPeriod: number; Retries: number };
        expect(hc.StartPeriod).toBeGreaterThan(0);
        expect(hc.Retries).toBeGreaterThanOrEqual(5);
      }
    });

    it('declares no health check on the six workers (no HTTP surface)', () => {
      for (const w of [
        'stripe-worker',
        'projection-worker',
        'login-email-worker',
        'email-change-worker',
        'message-worker',
        'push-worker',
      ]) {
        expect(healthCheckOf(`dad-${w}`)).toBeUndefined();
      }
    });

    it('enables the deployment circuit breaker with rollback on all 9 services', () => {
      const t = Template.fromStack(buildGraph('staging').services);
      const services = t.findResources('AWS::ECS::Service');
      expect(Object.keys(services)).toHaveLength(9);
      for (const svc of Object.values(services)) {
        expect(svc.Properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({
          Enable: true,
          Rollback: true,
        });
      }
    });
  });

  // config.workersEnabled is the ONE worker switch: it sets the desired count, and
  // DAD-Main's deploy.yml reads that from ECS instead of keeping its own flag.
  describe('worker switch', () => {
    const WORKERS = [
      'stripe-worker',
      'projection-worker',
      'login-email-worker',
      'email-change-worker',
      'message-worker',
      'push-worker',
    ];
    const counts = (t: Template) =>
      Object.fromEntries(
        Object.values(t.findResources('AWS::ECS::Service')).map((s) => [
          s.Properties.ServiceName,
          s.Properties.DesiredCount,
        ]),
      );

    it.each(['staging', 'production'] as const)('%s: workers are off by default', (env) => {
      const t = Template.fromStack(buildGraph(env).services);
      const c = counts(t);
      for (const w of WORKERS) expect([w, c[w]]).toEqual([w, 0]);
      // The HTTP services are unaffected: their count is owned by autoscaling, whose
      // floor is the configured desired count.
      const mins = Object.values(
        t.findResources('AWS::ApplicationAutoScaling::ScalableTarget'),
      ).map((r) => r.Properties.MinCapacity);
      expect(mins).toHaveLength(3);
      for (const m of mins) expect(m).toBeGreaterThan(0);
    });

    it('turning the switch on runs each worker at its configured count', () => {
      const g = buildGraph('production', { workersEnabled: true });
      const c = counts(Template.fromStack(g.services));
      for (const w of WORKERS) expect([w, c[w]]).toEqual([w, g.config.desiredCounts.workers]);
      expect(g.config.desiredCounts.workers).toBeGreaterThan(0);
    });

    it('always sets DONOR_GO_WORKERS_ENABLED=true, which the worker binary requires', () => {
      for (const enabled of [false, true]) {
        const t = Template.fromStack(buildGraph('staging', { workersEnabled: enabled }).services);
        const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition'));
        for (const w of WORKERS) {
          const def = defs.find((d) => d.Properties.Family === `dad-${w}`);
          const env = def!.Properties.ContainerDefinitions[0].Environment as Array<{ Name: string; Value: string }>;
          expect(env).toContainEqual({ Name: 'DONOR_GO_WORKERS_ENABLED', Value: 'true' });
        }
      }
    });
  });

  it('api registers in Service Connect reachable as api:8002', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    t.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'api',
      ServiceConnectConfiguration: Match.objectLike({
        Enabled: true,
        Namespace: 'dad.staging.local',
        Services: Match.arrayWith([
          Match.objectLike({
            PortName: 'api',
            ClientAliases: Match.arrayWith([
              Match.objectLike({ DnsName: 'api', Port: 8002 }),
            ]),
          }),
        ]),
      }),
    });
  });

  describe('autoscaling', () => {
    const targets = (t: Template) =>
      Object.values(t.findResources('AWS::ApplicationAutoScaling::ScalableTarget'));
    const policies = (t: Template) =>
      Object.values(t.findResources('AWS::ApplicationAutoScaling::ScalingPolicy'));

    it.each([
      ['staging', { api: [1, 3], web: [1, 3], nginx: [1, 2] }],
      ['production', { api: [2, 12], web: [2, 12], nginx: [2, 6] }],
    ] as const)('%s: api, web and nginx scale between their desired count and the env max', (env, bounds) => {
      const t = Template.fromStack(buildGraph(env).services);
      const found = targets(t).map((r) => [
        JSON.stringify(r.Properties.ResourceId),
        r.Properties.MinCapacity,
        r.Properties.MaxCapacity,
      ]);
      expect(found).toHaveLength(3);
      for (const [name, [min, max]] of Object.entries(bounds)) {
        const hit = found.find((f) => String(f[0]).includes(`service/`) && String(f[0]).includes(name === 'api' ? 'ApiService' : name === 'web' ? 'WebService' : 'NginxService'));
        expect(hit).toBeDefined();
        expect([hit![1], hit![2]]).toEqual([min, max]);
      }
      t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        ScalableDimension: 'ecs:service:DesiredCount',
        ServiceNamespace: 'ecs',
      });
    });

    it('tracks CPU for all three and memory for api and web, with slow scale-in', () => {
      const t = Template.fromStack(buildGraph('production').services);
      const byMetric = (metric: string) =>
        policies(t).filter(
          (p) =>
            p.Properties.TargetTrackingScalingPolicyConfiguration.PredefinedMetricSpecification
              .PredefinedMetricType === metric,
        );
      expect(byMetric('ECSServiceAverageCPUUtilization')).toHaveLength(3);
      expect(byMetric('ECSServiceAverageMemoryUtilization')).toHaveLength(2);
      for (const p of policies(t)) {
        const c = p.Properties.TargetTrackingScalingPolicyConfiguration;
        expect(p.Properties.PolicyType).toBe('TargetTrackingScaling');
        expect(c.ScaleInCooldown).toBe(300);
        expect(c.ScaleOutCooldown).toBe(60);
      }
      expect(byMetric('ECSServiceAverageCPUUtilization')[0].Properties
        .TargetTrackingScalingPolicyConfiguration.TargetValue).toBe(60);
    });

    it('does not autoscale the workers', () => {
      const t = Template.fromStack(buildGraph('production', { workersEnabled: true }).services);
      expect(targets(t)).toHaveLength(3);
    });

    it('leaves the desired count out of the template for autoscaled services so a deploy does not reset them', () => {
      const t = Template.fromStack(buildGraph('production', { workersEnabled: true }).services);
      const services = Object.values(t.findResources('AWS::ECS::Service'));
      const byName = (n: string) => services.find((s) => s.Properties.ServiceName === n)!;
      for (const n of ['api', 'web', 'nginx']) {
        expect(byName(n).Properties.DesiredCount).toBeUndefined();
      }
      expect(byName('stripe-worker').Properties.DesiredCount).toBe(1);
    });

    it('when switched off, pins the fixed desired counts and creates no scaling resources', () => {
      const base = buildGraph('production').config.autoscaling;
      const t = Template.fromStack(
        buildGraph('production', { autoscaling: { ...base, enabled: false } }).services,
      );
      expect(targets(t)).toHaveLength(0);
      const services = Object.values(t.findResources('AWS::ECS::Service'));
      expect(services.find((s) => s.Properties.ServiceName === 'api')!.Properties.DesiredCount).toBe(2);
    });

    it('is configurable: a different max and no memory target', () => {
      const base = buildGraph('staging').config.autoscaling;
      const t = Template.fromStack(
        buildGraph('staging', {
          autoscaling: { ...base, api: { maxCount: 7, cpuTargetPercent: 50 } },
        }).services,
      );
      expect(targets(t).map((r) => r.Properties.MaxCapacity)).toContain(7);
      expect(
        policies(t).filter((p) =>
          JSON.stringify(p.Properties.ScalingTargetId).includes('Api'),
        ),
      ).toHaveLength(1);
    });

    it('refuses a max below the desired count', () => {
      const base = buildGraph('production').config.autoscaling;
      expect(() =>
        buildGraph('production', {
          autoscaling: { ...base, web: { maxCount: 1, cpuTargetPercent: 60 } },
        }),
      ).toThrow(/maxCount \(1\) is below the desired count \(2\)/);
    });
  });
});
