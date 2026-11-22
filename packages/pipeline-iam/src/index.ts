/**
 * Shared GitHub Actions OIDC pipeline primitives for the DAD estate.
 *
 * A GitHub Actions OIDC provider is an account-level singleton, so it is owned
 * here once. Each app contributes its own scoped deploy roles via
 * {@link scopedDeployRole}.
 */
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The GitHub Actions OIDC issuer URL. */
export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

/** The OIDC issuer host (without scheme), used for condition keys. */
export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/** The audience GitHub's OIDC tokens are minted for when targeting AWS STS. */
export const OIDC_AUDIENCE = 'sts.amazonaws.com';

/** Props for {@link GitHubOidcProvider}. */
export interface GitHubOidcProviderProps {
  /**
   * Optional override of the issuer URL. Defaults to the GitHub Actions OIDC
   * endpoint. Exposed only for tests; production always uses the default.
   */
  readonly url?: string;
}

/**
 * The account-level GitHub Actions OIDC provider.
 *
 * One per account. Apps reference `.provider` when minting deploy roles.
 */
export class GitHubOidcProvider extends Construct {
  public readonly provider: iam.OpenIdConnectProvider;

  constructor(scope: Construct, id: string, props: GitHubOidcProviderProps = {}) {
    super(scope, id);

    this.provider = new iam.OpenIdConnectProvider(this, 'Provider', {
      url: props.url ?? GITHUB_OIDC_URL,
      clientIds: [OIDC_AUDIENCE],
    });
  }
}

/** GitHub Environment names, matching the CDK env names. */
export type DeployEnv = 'staging' | 'production';

/**
 * The `sub` claim GitHub issues to a job that runs under a GitHub Environment:
 * `repo:<owner>/<repo>:environment:<name>`.
 *
 * When a job sets `environment:`, GitHub uses this form and NOT the branch or tag
 * form, so a role that must be assumed by such a job has to trust this exact value.
 * The GitHub Environment names are `staging` and `production`, matching the CDK
 * env names.
 */
export function githubEnvironmentSubject(
  repo: string,
  env: DeployEnv,
): string {
  return `repo:${repo}:environment:${env}`;
}

/**
 * Build an {@link iam.OpenIdConnectPrincipal} that trusts exactly one repo's GitHub
 * Environment: `aud` pinned to STS and `sub` an exact match (no wildcards) on
 * {@link githubEnvironmentSubject}.
 *
 * The trust is only as narrow as the GitHub Environment itself. Any job in `repo`
 * that runs under this environment can assume the role, so restrict which branches
 * and tags may deploy to the environment in the repository settings.
 */
export function githubEnvironmentPrincipal(
  provider: iam.IOpenIdConnectProvider,
  repo: string,
  env: DeployEnv,
): iam.OpenIdConnectPrincipal {
  return new iam.OpenIdConnectPrincipal(provider, {
    StringEquals: {
      [`${GITHUB_OIDC_HOST}:aud`]: OIDC_AUDIENCE,
      [`${GITHUB_OIDC_HOST}:sub`]: githubEnvironmentSubject(repo, env),
    },
  });
}

/** Options for {@link scopedDeployRole}. */
export interface ScopedDeployRoleProps {
  /** The account-level OIDC provider. */
  readonly provider: iam.IOpenIdConnectProvider;
  /** GitHub `owner/repo` slug the role trusts. */
  readonly repo: string;
  /** Environment governing the trusted subject claims. */
  readonly env: DeployEnv;
  /** Explicit IAM role name. */
  readonly roleName: string;
  /** Human-readable role description. */
  readonly description?: string;
  /** Max assumed-session duration. Defaults to 1 hour. */
  readonly maxSessionDuration?: Duration;
}

/**
 * Mint a least-privilege GitHub-OIDC-assumable deploy role.
 *
 * The role trusts exactly the given repo's GitHub Environment (see
 * {@link githubEnvironmentPrincipal}). This package deliberately offers no branch or
 * tag form: every DAD deploy job runs under a GitHub Environment, which is where branch
 * and approval rules are enforced, so that is the only trust a deploy role may have.
 * Callers attach their own narrowly-scoped policy statements to the returned
 * role (e.g. ATM's "StartBuild on exactly this project").
 */
export function scopedDeployRole(
  scope: Construct,
  id: string,
  props: ScopedDeployRoleProps,
): iam.Role {
  return new iam.Role(scope, id, {
    roleName: props.roleName,
    assumedBy: githubEnvironmentPrincipal(props.provider, props.repo, props.env),
    description: props.description,
    maxSessionDuration: props.maxSessionDuration ?? Duration.hours(1),
  });
}
