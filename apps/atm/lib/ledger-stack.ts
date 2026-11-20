import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { AtmEnvConfig } from './atm-config';

/** Props for {@link LedgerStack}. */
export interface LedgerStackProps extends cdk.StackProps {
  readonly config: AtmEnvConfig;
}

/** Partition key attribute name: holds `source#<repo>`. */
export const LEDGER_PK = 'source';
/** Sort key attribute name: holds `finding#<normalized-signature>`. */
export const LEDGER_SK = 'finding';
/** The `status` attribute, projected into the by-status GSI. */
export const LEDGER_STATUS_ATTR = 'status';
/** Name of the "unresolved blocking findings for this source" GSI. */
export const BY_STATUS_INDEX = 'by-status';

/**
 * LedgerStack.
 *
 * The DynamoDB finding ledger — the small, keyed, mutable, concurrency-safe
 * finding store. Findings are grouped by `(source repo, normalized signature)`
 * and updated with conditional writes so concurrent runs are safe.
 *
 * The GSI `by-status` (PK `source`, SK `status`) services the "unresolved blocking
 * findings for this source" query.
 *
 * On-demand billing (spiky commit-triggered load), PITR, SSE, and
 * deletion protection toggled per env.
 */
export class LedgerStack extends cdk.Stack {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: LedgerStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.table = new dynamodb.Table(this, 'FindingsTable', {
      tableName: `${config.prefix}-findings-${config.env}`,
      partitionKey: { name: LEDGER_PK, type: dynamodb.AttributeType.STRING },
      sortKey: { name: LEDGER_SK, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: config.deletionProtection,
      removalPolicy: config.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: BY_STATUS_INDEX,
      partitionKey: { name: LEDGER_PK, type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: LEDGER_STATUS_ATTR,
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    new cdk.CfnOutput(this, 'FindingsTableName', {
      value: this.table.tableName,
      description: 'ATM findings ledger table name.',
    });
    new cdk.CfnOutput(this, 'FindingsTableArn', {
      value: this.table.tableArn,
      description: 'ATM findings ledger table ARN.',
    });
  }
}
