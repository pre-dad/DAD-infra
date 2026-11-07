import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { EnvConfig } from './config';

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4, ips-v6). */
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/**
 * TCP connect to the traffic port. nginx's own /health listener is bound to the task's
 * loopback (127.0.0.1:8081), which the NLB cannot reach; the container health check
 * covers it, and ECS only registers a task once that passes.
 */
const HEALTH_CHECK: elbv2.HealthCheck = {
  protocol: elbv2.Protocol.TCP,
  interval: cdk.Duration.seconds(10),
};

/** Props for {@link EdgeStack}. */
export interface EdgeStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  readonly publicSubnets: ec2.SubnetSelection;
  /** The nginx Fargate service the NLB targets. */
  readonly nginxService: ecs.FargateService;
  /** The nginx SG whose ingress the Cloudflare toggle restricts. */
  readonly nginxSecurityGroup: ec2.ISecurityGroup;
  /** The NLB-path SG from the network stack. */
  readonly nlbSecurityGroup: ec2.ISecurityGroup;
}

/**
 * EdgeStack.
 *
 * Internet-facing Network Load Balancer with TCP listeners 443→nginx:8443 and
 * 80→nginx:8080, targeting the nginx service with TCP health checks on the traffic
 * port and a 30 s deregistration delay. When
 * config.cloudflareIngressEnabled is set, the nginx SG's edge ingress is
 * restricted to Cloudflare's published ranges instead of the open internet.
 *
 * The ranges come from CDK context `cloudflareRanges`, defaulting to Cloudflare's
 * published lists (https://www.cloudflare.com/ips-v4 and ips-v6) as of the last review.
 * The NLB's own security group admits only those ranges on 80/443; without a rule it
 * admits nothing.
 */
export class EdgeStack extends cdk.Stack {
  public readonly loadBalancer: elbv2.NetworkLoadBalancer;
  public readonly httpsListener: elbv2.NetworkListener;
  public readonly httpListener: elbv2.NetworkListener;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      publicSubnets,
      nginxService,
      nginxSecurityGroup,
      nlbSecurityGroup,
    } = props;

    this.loadBalancer = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      vpc,
      vpcSubnets: publicSubnets,
      internetFacing: true,
      loadBalancerName: `dad-${config.env}-nlb`,
      securityGroups: [nlbSecurityGroup as ec2.SecurityGroup],
    });

    // HTTPS: TCP 443 → nginx 8443.
    this.httpsListener = this.loadBalancer.addListener('Https', {
      port: 443,
      protocol: elbv2.Protocol.TCP,
    });
    this.httpsListener.addTargets('NginxHttps', {
      port: 8443,
      protocol: elbv2.Protocol.TCP,
      targets: [nginxService.loadBalancerTarget({
        containerName: 'nginx-Container',
        containerPort: 8443,
      })],
      healthCheck: HEALTH_CHECK,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // HTTP: TCP 80 → nginx 8080.
    this.httpListener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.Protocol.TCP,
    });
    this.httpListener.addTargets('NginxHttp', {
      port: 8080,
      protocol: elbv2.Protocol.TCP,
      targets: [nginxService.loadBalancerTarget({
        containerName: 'nginx-Container',
        containerPort: 8080,
      })],
      healthCheck: HEALTH_CHECK,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // --- Cloudflare ingress toggle --------------------------------------
    // A load balancer with a security group drops everything its group does not allow,
    // so the NLB group carries the public rules; nginx admits the NLB group (network
    // stack) and, below, the same ranges.
    const publicPorts = [80, 443];
    for (const port of publicPorts) {
      if (config.cloudflareIngressEnabled) {
        for (const cidr of this.cloudflareRanges()) {
          nlbSecurityGroup.addIngressRule(
            cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr),
            ec2.Port.tcp(port),
            `NLB ${port} from Cloudflare ${cidr}`,
          );
        }
      } else {
        nlbSecurityGroup.addIngressRule(
          ec2.Peer.anyIpv4(),
          ec2.Port.tcp(port),
          `NLB ${port} from internet (cloudflare toggle off)`,
        );
      }
    }

    const edgePorts = [
      { port: 8080, label: 'http' },
      { port: 8443, label: 'https' },
    ];

    if (config.cloudflareIngressEnabled) {
      for (const cidr of this.cloudflareRanges()) {
        const isV6 = cidr.includes(':');
        for (const { port, label } of edgePorts) {
          nginxSecurityGroup.addIngressRule(
            isV6 ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr),
            ec2.Port.tcp(port),
            `nginx ${label} from Cloudflare ${cidr}`,
          );
        }
      }
    } else {
      for (const { port, label } of edgePorts) {
        nginxSecurityGroup.addIngressRule(
          ec2.Peer.anyIpv4(),
          ec2.Port.tcp(port),
          `nginx ${label} from internet (cloudflare toggle off)`,
        );
      }
    }

    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description:
        'NLB DNS name — point the Cloudflare DNS records for the public/staff hosts at this.',
    });
  }

  /** Cloudflare ranges: CDK context `cloudflareRanges` (list or comma/space separated), else the default. */
  private cloudflareRanges(): string[] {
    const ctx = this.node.tryGetContext('cloudflareRanges') as
      | string
      | string[]
      | undefined;
    if (Array.isArray(ctx)) {
      return ctx;
    }
    if (typeof ctx === 'string' && ctx.trim() !== '') {
      return ctx.split(/[\s,]+/).filter((s) => s !== '');
    }
    return CLOUDFLARE_RANGES;
  }
}
