import * as cdk from 'aws-cdk-lib';
import { EnvConfig } from './config';
import { NetworkStack } from './network-stack';
import { DataStack } from './data-stack';
import { EcsClusterStack } from './ecs-cluster-stack';
import { ServicesStack } from './services-stack';
import { MaintenanceStack } from './maintenance-stack';
import { EdgeStack } from './edge-stack';
import { ObservabilityStack } from './observability-stack';
import { SesStack } from './ses-stack';
import { AppSecretsStack } from './app-secrets-stack';
import { PipelineIamStack } from './pipeline-iam-stack';
import { BackupStack, DrBackupVaultStack } from './backup-stack';

/**
 * Instantiate the DAD-Main stack graph for one environment:
 *   network → data → ecs-cluster → services → {maintenance, edge, observability}
 *   ses, app-secrets and pipeline-iam are independent; backup (production only) follows
 *   data and a destination-region vault stack.
 *
 * Stacks are named `dad-<name>-<env>` and carry termination protection wherever the
 * environment has deletion protection, so production cannot be deleted by accident.
 */
export function buildDadApp(app: cdk.App, config: EnvConfig, env: cdk.Environment) {
  const terminationProtection = config.deletionProtection;
  const stackId = (name: string): string => `dad-${name}-${config.env}`;

  // 1. Network — VPC, subnets, SG chain.
  const network = new NetworkStack(app, stackId('network'), { env, config, terminationProtection });

  // 2. Data — RDS + RDS Proxy + per-login secrets.
  const data = new DataStack(app, stackId('data'), {
    env,
    config,
    terminationProtection,
    vpc: network.vpc,
    isolatedSubnets: network.isolatedSubnets,
    proxySecurityGroup: network.proxySecurityGroup,
  });

  // 3. ECS cluster — Fargate cluster, Service Connect namespace, ECR, log groups.
  const ecsCluster = new EcsClusterStack(app, stackId('ecs-cluster'), {
    env,
    config,
    terminationProtection,
    vpc: network.vpc,
  });

  // SES (sending identity + SMTP secret) and the application secrets come before the
  // services, which inject them.
  const ses = new SesStack(app, stackId('ses'), { env, config, terminationProtection });
  const appSecrets = new AppSecretsStack(app, stackId('app-secrets'), { env, config, terminationProtection });
  // 4. Services — the nine long-running Fargate services.
  const services = new ServicesStack(app, stackId('services'), {
    env,
    config,
    terminationProtection,
    computeSubnets: network.computeSubnets,
    cluster: ecsCluster.cluster,
    namespaceName: ecsCluster.namespaceName,
    repositories: ecsCluster.repositories,
    logGroups: ecsCluster.logGroups,
    proxyEndpoint: data.proxyEndpoint,
    loginSecrets: data.loginSecrets,
    computeSubnetCidrs: network.computeSubnetCidrs,
    nginxSecurityGroup: network.nginxSecurityGroup,
    webSecurityGroup: network.webSecurityGroup,
    apiSecurityGroup: network.apiSecurityGroup,
    workersSecurityGroup: network.workersSecurityGroup,
    appSecrets: {
      stripe: appSecrets.stripe,
      encryption: appSecrets.encryption,
      tls: appSecrets.tls,
      signIn: appSecrets.signIn,
      webOAuth: appSecrets.webOAuth,
      smtp: ses.smtpSecret,
    },
  });

  // 5. Maintenance — one-off task defs + scheduled reconcile + exit alarm.
  const maintenance = new MaintenanceStack(app, stackId('maintenance'), {
    env,
    config,
    terminationProtection,
    vpc: network.vpc,
    computeSubnets: network.computeSubnets,
    cluster: ecsCluster.cluster,
    repositories: ecsCluster.repositories,
    proxyEndpoint: data.proxyEndpoint,
    loginSecrets: data.loginSecrets,
    masterSecret: data.masterSecret,
    databaseHost: data.instance.dbInstanceEndpointAddress,
    workersSecurityGroup: network.workersSecurityGroup,
    appSecrets: {
      stripe: appSecrets.stripe,
      encryption: appSecrets.encryption,
      tls: appSecrets.tls,
      signIn: appSecrets.signIn,
      webOAuth: appSecrets.webOAuth,
      smtp: ses.smtpSecret,
    },
  });

  // 6. Edge — internet-facing NLB + Cloudflare SG toggle.
  const edge = new EdgeStack(app, stackId('edge'), {
    env,
    config,
    terminationProtection,
    vpc: network.vpc,
    publicSubnets: network.publicSubnets,
    nginxService: services.services.nginx,
    nginxSecurityGroup: network.nginxSecurityGroup,
    nlbSecurityGroup: network.nlbSecurityGroup,
  });

  // 7. Observability — SNS topic + ECS health + database alarms.
  const observability = new ObservabilityStack(app, stackId('observability'), {
    env,
    config,
    terminationProtection,
    clusterName: ecsCluster.cluster.clusterName,
    services: services.services,
    database: data.instance,
  });

  // 8. Backup — production only: AWS Backup plan copying database backups to a second region.
  const drRegion = config.crossRegionBackupRegion;
  let backup: BackupStack | undefined;
  let drVault: DrBackupVaultStack | undefined;
  if (drRegion) {
    drVault = new DrBackupVaultStack(app, stackId('dr-vault'), {
      env: { account: env.account, region: drRegion },
      config,
      terminationProtection,
    });
    backup = new BackupStack(app, stackId('backup'), {
      env,
      config,
      database: data.instance,
      destinationRegion: drRegion,
      terminationProtection,
    });
    backup.addDependency(drVault);
  }

  // 9. Pipeline IAM — GitHub OIDC provider + deploy roles.
  const pipelineIam = new PipelineIamStack(app, stackId('pipeline-iam'), {
    env,
    config,
    terminationProtection,
  });

  return {
    network,
    data,
    ecsCluster,
    ses,
    appSecrets,
    services,
    maintenance,
    edge,
    observability,
    backup,
    drVault,
    pipelineIam,
  };
}
