import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvConfig } from './config';
import { toRetentionDays } from './ecs-cluster-stack';

/** Props for {@link NetworkStack}. */
export interface NetworkStackProps extends cdk.StackProps {
  /** Resolved per-environment configuration. */
  readonly config: EnvConfig;
}

/**
 * NetworkStack.
 *
 * A dedicated VPC per environment across 2+ AZs with three subnet tiers:
 *   - public               → NLB
 *   - private-with-egress  → nginx / web / api / workers (NAT for Stripe, SES,
 *                            APNs/FCM, image pulls)
 *   - isolated             → RDS + RDS Proxy
 *
 * It also owns the full security-group chain that mirrors the Compose network
 * isolation (docker-compose.prod.yml):
 *
 *   NLB → nginx(8080,8443) → web(3000) → api(8002) → RDS Proxy(5432) → RDS(5432)
 *
 * Workers get a security group with no inbound at all. Every SG and the subnet
 * selections are exposed as public readonly props so later stacks (data, ecs
 * cluster, services, edge) can reference them without re-deriving anything.
 */
export class NetworkStack extends cdk.Stack {
  /** The dedicated VPC for this environment. */
  public readonly vpc: ec2.Vpc;

  /** SG applied to the internet-facing NLB target ENIs path (nginx tier edge). */
  public readonly nlbSecurityGroup: ec2.SecurityGroup;
  /** SG for the nginx (edge ingress) service. */
  public readonly nginxSecurityGroup: ec2.SecurityGroup;
  /** SG for the web (Next.js) service. */
  public readonly webSecurityGroup: ec2.SecurityGroup;
  /** SG for the api service. */
  public readonly apiSecurityGroup: ec2.SecurityGroup;
  /** SG for the six worker services (no inbound). */
  public readonly workersSecurityGroup: ec2.SecurityGroup;
  /** SG for the RDS Proxy. */
  public readonly proxySecurityGroup: ec2.SecurityGroup;
  /** SG on the interface endpoints (443 from the compute tier); undefined when they are off. */
  public readonly endpointSecurityGroup?: ec2.SecurityGroup;
  /** Log group the VPC flow logs are delivered to. */
  public readonly flowLogGroup: logs.LogGroup;

  /** Subnet selection for the private-with-egress compute tier. */
  public readonly computeSubnets: ec2.SubnetSelection;
  /** Subnet selection for the isolated data tier. */
  public readonly isolatedSubnets: ec2.SubnetSelection;
  /** Subnet selection for the public (NLB) tier. */
  public readonly publicSubnets: ec2.SubnetSelection;

  // Named subnet-group constants so selections stay in sync with construction.
  private static readonly PUBLIC_SUBNET = 'public';
  private static readonly COMPUTE_SUBNET = 'compute';
  private static readonly ISOLATED_SUBNET = 'data';

  /**
   * Pin the AZs to the two canonical us-east-2 zones. A VPC with maxAzs in a
   * concrete environment would otherwise trigger a context lookup (an AWS call)
   * that breaks offline synth; returning fixed AZs keeps `cdk synth` fully
   * offline while still giving two-AZ coverage in us-east-2.
   */
  public get availabilityZones(): string[] {
    return ['us-east-2a', 'us-east-2b'];
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Dedicated VPC, 2 AZs. NAT gateways give the private-with-egress tier
    // outbound reachability for Stripe/SES/APNs/FCM and ECR image pulls.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: config.multiAz ? 2 : 1,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
        {
          name: NetworkStack.PUBLIC_SUBNET,
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: NetworkStack.COMPUTE_SUBNET,
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22,
        },
        {
          name: NetworkStack.ISOLATED_SUBNET,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.publicSubnets = { subnetGroupName: NetworkStack.PUBLIC_SUBNET };
    this.computeSubnets = { subnetGroupName: NetworkStack.COMPUTE_SUBNET };
    this.isolatedSubnets = { subnetGroupName: NetworkStack.ISOLATED_SUBNET };

    // --- Security groups (one per tier) ---------------------------------
    this.nlbSecurityGroup = new ec2.SecurityGroup(this, 'NlbSg', {
      vpc: this.vpc,
      description: 'DAD NLB edge path (TCP 80/443 from Cloudflare ranges).',
      allowAllOutbound: true,
    });

    this.nginxSecurityGroup = new ec2.SecurityGroup(this, 'NginxSg', {
      vpc: this.vpc,
      description: 'DAD nginx ingress service.',
      allowAllOutbound: true,
    });

    this.webSecurityGroup = new ec2.SecurityGroup(this, 'WebSg', {
      vpc: this.vpc,
      description: 'DAD web (Next.js) service.',
      allowAllOutbound: true,
    });

    this.apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc: this.vpc,
      description: 'DAD api service.',
      allowAllOutbound: true,
    });

    this.workersSecurityGroup = new ec2.SecurityGroup(this, 'WorkersSg', {
      vpc: this.vpc,
      description: 'DAD worker services (no inbound).',
      allowAllOutbound: true,
    });

    this.proxySecurityGroup = new ec2.SecurityGroup(this, 'ProxySg', {
      vpc: this.vpc,
      description: 'DAD RDS Proxy.',
      allowAllOutbound: true,
    });

    // --- SG chain (mirrors the Compose network isolation) ---------------
    // nginx accepts the edge ports from the NLB path only (8080 http, 8443 https).
    this.nginxSecurityGroup.addIngressRule(
      this.nlbSecurityGroup,
      ec2.Port.tcp(8080),
      'nginx http from NLB',
    );
    this.nginxSecurityGroup.addIngressRule(
      this.nlbSecurityGroup,
      ec2.Port.tcp(8443),
      'nginx https from NLB',
    );

    // web accepts 3000 from nginx only (nginx → web through Service Connect).
    this.webSecurityGroup.addIngressRule(
      this.nginxSecurityGroup,
      ec2.Port.tcp(3000),
      'web from nginx',
    );

    // api accepts 8002 from web only (Service Connect web→api).
    this.apiSecurityGroup.addIngressRule(
      this.webSecurityGroup,
      ec2.Port.tcp(8002),
      'api from web',
    );

    // RDS Proxy accepts 5432 from api and workers only.
    this.proxySecurityGroup.addIngressRule(
      this.apiSecurityGroup,
      ec2.Port.tcp(5432),
      'proxy from api',
    );
    this.proxySecurityGroup.addIngressRule(
      this.workersSecurityGroup,
      ec2.Port.tcp(5432),
      'proxy from workers',
    );

    // RDS SG ingress (proxy → RDS:5432) is created inside DataStack alongside
    // the RDS instance to keep that bidirectional wiring in a single stack and
    // avoid a cross-stack dependency cycle.

    // --- VPC endpoints --------------------------------------------------
    // Keep image pulls, secret resolution and log delivery for the compute tier on the
    // AWS network instead of the NAT gateway. The NAT stays for everything else
    // (Stripe, SMTP, APNs/FCM).
    //
    // The S3 gateway endpoint is free (ECR image layers are served from S3). The
    // interface endpoints cost per AZ-hour, so config.interfaceEndpointsEnabled can
    // turn them off (staging). No STS endpoint: the tasks make no STS calls; the
    // credentials ECS hands them come from the container credentials endpoint.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [this.computeSubnets],
    });

    if (config.interfaceEndpointsEnabled) {
      const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
        vpc: this.vpc,
        description: 'DAD interface VPC endpoints (HTTPS from the compute tier).',
        allowAllOutbound: false,
      });
      for (const [sg, label] of [
        [this.nginxSecurityGroup, 'nginx'],
        [this.webSecurityGroup, 'web'],
        [this.apiSecurityGroup, 'api'],
        [this.workersSecurityGroup, 'workers'],
      ] as const) {
        endpointSg.addIngressRule(sg, ec2.Port.tcp(443), `HTTPS from ${label}`);
      }
      this.endpointSecurityGroup = endpointSg;

      const interfaceEndpoints: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
        ['EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR],
        ['EcrDkrEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
        ['SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
        ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ];
      for (const [endpointId, service] of interfaceEndpoints) {
        this.vpc.addInterfaceEndpoint(endpointId, {
          service,
          subnets: this.computeSubnets,
          securityGroups: [endpointSg],
          privateDnsEnabled: true,
          // Ingress comes only from endpointSg (the compute-tier groups), not the VPC CIDR.
          open: false,
        });
      }
    }

    // --- VPC flow logs --------------------------------------------------
    // Accepted and rejected traffic (rejected only where config.flowLogTrafficType says
    // so) to CloudWatch Logs with the configured retention.
    this.flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: `/dad/${config.env}/vpc-flow-logs`,
      retention: toRetentionDays(config.flowLogRetentionDays),
      removalPolicy: config.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(this.flowLogGroup),
      trafficType: ec2.FlowLogTrafficType[config.flowLogTrafficType],
    });

    // --- Outputs --------------------------------------------------------
    // Stable, human-named CfnOutputs consumed by the app pipeline
    // (.github/workflows/deploy.yml → the "names" step) to run the migrate /
    // provision-roles ECS run-tasks: the compute-tier subnet ids and the
    // workers security-group id. The pipeline reads these exact keys
    // (ComputeSubnetIds, WorkersSecurityGroupId) off the dad-network-<env>
    // stack, so they must stay named and are intentionally separate from the
    // auto-generated cross-stack Fn::ImportValue exports CDK emits for props.
    new cdk.CfnOutput(this, 'ComputeSubnetIds', {
      description:
        'Comma-separated compute-tier (private-with-egress) subnet ids for ECS run-task networking.',
      value: cdk.Fn.join(
        ',',
        this.vpc.selectSubnets(this.computeSubnets).subnetIds,
      ),
    });
    new cdk.CfnOutput(this, 'WorkersSecurityGroupId', {
      description:
        'Security-group id for the workers tier, used by maintenance ECS run-tasks.',
      value: this.workersSecurityGroup.securityGroupId,
    });
  }

  /**
   * The private-with-egress (compute tier) subnet CIDRs. Used for
   * DONOR_TRUSTED_PROXY_CIDRS — the api trusts X-Real-IP only from the web
   * tier's subnets. The API refuses a range broader than IPv4 /8, so per-subnet
   * CIDRs are used, not a supernet.
   */
  public get computeSubnetCidrs(): string[] {
    return this.vpc
      .selectSubnets(this.computeSubnets)
      .subnets.map((s) => s.ipv4CidrBlock);
  }
}
