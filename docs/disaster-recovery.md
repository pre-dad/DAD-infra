# Disaster recovery (production database)

Production only. Staging has no cross-region copy (`crossRegionBackupRegion` is unset).

## What protects the data

| Layer | Where | Retention | Covers |
|---|---|---|---|
| RDS Multi-AZ standby | us-east-2, second AZ | n/a | instance or AZ failure (automatic failover) |
| RDS automated backups + point-in-time recovery | us-east-2 | 14 days | bad deploy, bad migration, data corruption |
| AWS Backup, `dad-production-vault` | us-east-2 | daily 14 days, monthly 12 months | accidental delete of the instance and its automated backups |
| AWS Backup copy, `dad-production-dr-vault` | us-west-2 (`crossRegionBackupRegion`) | same as source | loss of the us-east-2 region |

Stacks: `dad-backup-production` (us-east-2: key, vault, role, plan, selection of the one
database) and `dad-dr-vault-production` (us-west-2: key with rotation, vault). Both vaults
and keys are retained if the stacks are deleted, and every production stack has
termination protection. The plan runs daily at 05:00 UTC and on the 1st at 06:00 UTC;
each recovery point is copied to the us-west-2 vault, re-encrypted with that region's key.

RDS automated-backup replication is not a CloudFormation resource, which is why AWS Backup
is used. Point-in-time recovery does **not** cross regions: a regional restore comes from
the last copied snapshot.

## Assumptions

- **RPO.** Within the region: about 5 minutes (PITR). Regional loss: up to about 24 hours
  plus copy time (daily snapshot, copied after it completes), and anything written since
  the last completed copy is lost.
- **RTO.** Instance or AZ failure: a few minutes. PITR or snapshot restore in-region:
  about 1 to 2 hours for a 50 GiB database, growing with size. Regional loss: several hours,
  dominated by standing up the rest of the stack in us-west-2. These are estimates; no
  restore has been rehearsed.
- Secrets Manager secrets (`dad/production/*`) are not replicated. After a regional loss,
  the application secrets (Stripe, encryption keys, TLS) must be re-entered from their
  system of record, so keep those recoverable outside AWS.

## Restore: same region (accidental deletion or corruption)

1. For corruption within 14 days, restore to a point in time: RDS console, the database,
   Actions, Restore to point in time (new instance; never overwrite production).
2. Otherwise open AWS Backup, Vaults, `dad-production-vault`, pick a recovery point,
   Restore. Choose the same VPC, the isolated subnet group, the database security group
   and Multi-AZ off for speed (turn it on afterwards).
3. Verify the new instance (`migrate` status, row counts), then repoint: update the proxy
   target (`dad-production-proxy`) to the new instance or restore under the original
   identifier after the broken one is renamed.
4. Run `provision-roles` (see `docs/bootstrap.md`) if the restored database lacks the roles.

## Restore: region loss

1. AWS Backup in **us-west-2**, Vaults, `dad-production-dr-vault`, choose the newest
   recovery point, Restore. Pick a subnet group and security group in a VPC in us-west-2
   (create a VPC there first; the production network stack is us-east-2 only).
2. Deploy a minimal copy of the stack in us-west-2 (`CDK_DEFAULT_REGION=us-west-2`) or
   point a temporary service at the restored instance, update Cloudflare to the new
   origin, and verify.
3. Restore in-region protections (Multi-AZ, backups) before resuming normal operation.

The backup role is deliberately backup-only (`allowRestores: false`); restores run under an
operator's own permissions.

## Verify on first production deploy

Nothing here has run against AWS.

1. CDK is bootstrapped in **us-west-2** for the production account
   (`npx cdk bootstrap aws://<account>/us-west-2`); `dad-dr-vault-production` cannot
   deploy without it.
2. Deploy order: `dad-dr-vault-production` before `dad-backup-production` (CDK orders
   them; `--all` is fine). Confirm the vault `dad-production-dr-vault` exists in us-west-2
   and `dad-production-vault` in us-east-2.
3. Trigger an on-demand backup of the instance from the plan (AWS Backup, Protected
   resources) rather than waiting for 05:00 UTC. Confirm the backup job completes and
   a **copy job** to us-west-2 completes. If the copy fails with a KMS error, the RDS
   storage key is the AWS-managed `aws/rds` key; give the instance a customer-managed key
   or add the key permissions the error names.
4. Confirm recovery points appear in both vaults and the retention shows 14 days.
5. Rehearse one restore from the us-west-2 copy into a throwaway instance and record the
   real RTO here.
6. Add a CloudWatch alarm or AWS Backup notification on failed backup and copy jobs once
   the observability topic is subscribed (not part of this change).
