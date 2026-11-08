import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { EnvConfig } from './config';
import { ALL_LOGINS, ProcessLogin } from './db-url';

/** Props for {@link DataStack}. */
export interface DataStackProps extends cdk.StackProps {
  /** Resolved per-environment configuration. */
  readonly config: EnvConfig;
  /** The dedicated VPC from the network stack. */
  readonly vpc: ec2.IVpc;
  /** Isolated subnet selection for RDS + RDS Proxy. */
  readonly isolatedSubnets: ec2.SubnetSelection;
  /** SG for the RDS Proxy (owned by the network stack). */
  readonly proxySecurityGroup: ec2.ISecurityGroup;
}

/**
 * DataStack.
 *
 * RDS PostgreSQL 16 in the isolated subnets (encrypted storage, automated
 * backups, multiAz + deletionProtection driven by config), fronted by an RDS
 * Proxy in transaction pooling mode. CDK mints one Secrets Manager secret per
 * login — 11 per-process logins + the owner login (from db-url.ts
 * {@link ALL_LOGINS}) — plus the RDS master secret. These login secrets are
 * passed to the proxy so each process authenticates with its own credentials.
 *
 * CDK does NOT create the Postgres roles themselves: the `migrate` and
 * `provision-roles` maintenance tasks do that after the schema exists.
 */
export class DataStack extends cdk.Stack {
  /** The RDS PostgreSQL instance. */
  public readonly instance: rds.DatabaseInstance;
  /** The RDS Proxy (transaction mode) every process connects through. */
  public readonly proxy: rds.DatabaseProxy;
  /** The read/write proxy endpoint host used to build DB URLs. */
  public readonly proxyEndpoint: string;
  /** The RDS master credentials secret. */
  public readonly masterSecret: secretsmanager.ISecret;
  /** One secret per login, keyed by login name (11 process + owner). */
  public readonly loginSecrets: Record<string, secretsmanager.Secret>;
  /** The SG for the RDS instance (owned here to avoid a cross-stack cycle). */
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  /**
   * Security group for the one-off owner bootstrap task (maintenance stack). It is the
   * only thing besides the RDS Proxy that may reach the instance, because the master
   * secret is deliberately not registered with the proxy.
   */
  public readonly bootstrapSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config, vpc, isolatedSubnets, proxySecurityGroup } = props;

    // RDS instance SG — created here (not in the network stack) so the
    // proxy→RDS:5432 ingress rule and the RDS endpoint port live in one stack.
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'DAD RDS PostgreSQL instance.',
      allowAllOutbound: true,
    });
    this.databaseSecurityGroup.addIngressRule(
      proxySecurityGroup,
      ec2.Port.tcp(5432),
      'rds from proxy',
    );
    this.bootstrapSecurityGroup = new ec2.SecurityGroup(this, 'BootstrapSg', {
      vpc,
      description: 'DAD one-off database owner bootstrap task (connects to RDS directly).',
      // Outbound: RDS, the RDS CA bundle (HTTPS), and the image pull through NAT.
      allowAllOutbound: true,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.bootstrapSecurityGroup,
      ec2.Port.tcp(5432),
      'rds from the owner bootstrap task',
    );

    const removalPolicy = config.deletionProtection
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // The master secret is created here, not by the instance, so its removal policy can be
    // set: the instance only exposes the attachment, whose policy does not reach the secret.
    const masterSecret = new rds.DatabaseSecret(this, 'MasterSecret', {
      username: 'dad_master',
      secretName: `dad/${config.env}/rds/master`,
    });
    masterSecret.applyRemovalPolicy(removalPolicy);

    // --- RDS PostgreSQL 16 ----------------------------------------------
    this.instance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      vpc,
      vpcSubnets: isolatedSubnets,
      securityGroups: [this.databaseSecurityGroup],
      instanceType: new ec2.InstanceType(config.database.instanceType),
      multiAz: config.multiAz,
      allocatedStorage: config.database.allocatedStorageGiB,
      maxAllocatedStorage: config.database.maxAllocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      enablePerformanceInsights: true,
      cloudwatchLogsExports: ['postgresql'],
      // Automated backups (these also provide point-in-time recovery).
      backupRetention: cdk.Duration.days(config.multiAz ? 14 : 7),
      deletionProtection: config.deletionProtection,
      databaseName: config.dbName,
      // Master credentials in Secrets Manager (used for the owner bootstrap).
      credentials: rds.Credentials.fromSecret(masterSecret),
      removalPolicy,
    });
    this.masterSecret = this.instance.secret!;

    // --- One Secrets Manager secret per login ---------------------------
    // 11 per-process logins + owner. CDK does NOT create the Postgres roles;
    // these secrets just hold the generated passwords the roles will be given.
    this.loginSecrets = {};
    const proxySecrets: secretsmanager.ISecret[] = [];
    for (const login of ALL_LOGINS as ProcessLogin[]) {
      const secret = new secretsmanager.Secret(
        this,
        `LoginSecret-${login.login}`,
        {
          removalPolicy,
          secretName: `dad/${config.env}/db/${login.login}`,
          description: `DAD ${config.env} DB login '${login.login}' (${login.envVar}).`,
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: login.login }),
            generateStringKey: 'password',
            // Passwords used in a URL; exclude chars needing percent-encoding.
            excludePunctuation: true,
            excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
            passwordLength: 32,
          },
        },
      );
      this.loginSecrets[login.login] = secret;
      proxySecrets.push(secret);
    }

    // --- RDS Proxy (transaction mode) -----------------------------------
    this.proxy = new rds.DatabaseProxy(this, 'Proxy', {
      proxyTarget: rds.ProxyTarget.fromInstance(this.instance),
      // Every login secret the proxy can authenticate (iamAuth off: the
      // processes present username/password from their own secret).
      secrets: proxySecrets,
      vpc,
      vpcSubnets: isolatedSubnets,
      securityGroups: [proxySecurityGroup],
      requireTLS: true,
      iamAuth: false,
      // Transaction pooling: required so default_query_exec_mode=exec works.
      // Session pinning stays off the hot path; pgx uses simple protocol.
      maxConnectionsPercent: 90,
      borrowTimeout: cdk.Duration.seconds(30),
      dbProxyName: `dad-${config.env}-proxy`,
    });
    this.proxyEndpoint = this.proxy.endpoint;

    // --- Outputs ---------------------------------------------------------
    new cdk.CfnOutput(this, 'ProxyEndpoint', {
      value: this.proxyEndpoint,
      description: 'RDS Proxy read/write endpoint host used to build DB URLs.',
    });
    new cdk.CfnOutput(this, 'BootstrapSecurityGroupId', {
      description: 'Security group to pass to run-task.sh for the bootstrap-owner task.',
      value: this.bootstrapSecurityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, 'MasterSecretArn', {
      value: this.masterSecret.secretArn,
      description: 'RDS master credentials secret ARN (owner bootstrap).',
    });
    for (const login of ALL_LOGINS as ProcessLogin[]) {
      new cdk.CfnOutput(this, `SecretArn-${login.login}`, {
        value: this.loginSecrets[login.login].secretArn,
        description: `Secret ARN for DB login '${login.login}' (${login.envVar}).`,
      });
    }
  }
}
