import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AtmEnvConfig } from './atm-config';

/** Props for {@link EvidenceStack}. */
export interface EvidenceStackProps extends cdk.StackProps {
  readonly config: AtmEnvConfig;
}

/**
 * EvidenceStack.
 *
 * The private S3 bucket that holds each run's bulky, immutable artifacts
 * (`run.json`, `report.html`, traces, screenshots), keyed by
 * `<source-repo>/<revision>/<run-id>/…`.
 *
 * Posture: Block Public Access (all four), SSE (S3-managed), versioning,
 * TLS-only (enforceSSL), and a lifecycle rule expiring objects after the
 * env's configured retention window (staging 90d / production 365d).
 */
export class EvidenceStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EvidenceStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.bucket = new s3.Bucket(this, 'EvidenceBucket', {
      bucketName: `${config.prefix}-evidence-${config.env}-${config.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      // Evidence is private and must survive the ephemeral runner.
      removalPolicy: config.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      // CloudFormation cannot delete a non-empty bucket.
      autoDeleteObjects: !config.deletionProtection,
      lifecycleRules: [
        {
          id: 'expire-evidence',
          enabled: true,
          expiration: cdk.Duration.days(config.evidenceRetentionDays),
          // Clean up old versions too (bucket is versioned).
          noncurrentVersionExpiration: cdk.Duration.days(
            config.evidenceRetentionDays,
          ),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        { id: 'expire-delete-markers', enabled: true, expiredObjectDeleteMarker: true },
      ],
    });

    new cdk.CfnOutput(this, 'EvidenceBucketName', {
      value: this.bucket.bucketName,
      description: 'ATM evidence bucket name.',
    });
    new cdk.CfnOutput(this, 'EvidenceBucketArn', {
      value: this.bucket.bucketArn,
      description: 'ATM evidence bucket ARN.',
    });
  }
}
