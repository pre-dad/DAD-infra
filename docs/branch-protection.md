# Branch protection — solo-friendly rulesets

DAD-infra follows the DAD family convention: **`main`** (default, stable) and **`dev`**
(working branch). The family's shared rules are in DAD-Docs
(`conventions/repos-and-branches.md`). Protection lives in **GitHub repository
settings**, not in the tree, so this document is the record of what is applied and how
to reapply it.

DAD-infra uses repository **rulesets** (not classic branch protection) and protects
**both** `main` and `dev`.

Two active rulesets exist, `protect-main` (targets `refs/heads/main`) and `protect-dev`
(targets `refs/heads/dev`). They are identical apart from name and target ref. Both are
`enforcement: active`, and both also set `require_extra_approval_for_unattributed_changes`
(on) and `strict_required_status_checks_policy` (on).

## What is applied

| Setting | Value | Why |
|---|---|---|
| Require a pull request | on | No direct pushes. |
| Required approvals | **0** | A solo owner cannot approve their own PR; raise to 1 when collaborators join. |
| Require conversation resolution | on | No unresolved review threads. |
| Required status check | `synth`, branch up to date | No red merges. |
| Block force-pushes | on | Protects history. |
| Block deletion | on | The branches cannot be deleted. |
| Bypass | **none** (`bypass_actors: []`) | Nobody, including repository admins, can merge past a failed or pending `synth` or push directly. If a check cannot report, fix the check or change the ruleset (see below). |

### Why `synth` must always run

A required check that never runs blocks the merge forever. The consolidated
`dad-main-infra.yml` workflow therefore has **no `paths:` filter on `pull_request`**.
Its single `synth` job installs/builds once, runs the full workspace and Cloudflare
tests once, and synthesizes both `apps/dad-main` and `apps/atm` in staging and
production without AWS credentials. The ruleset still requires `synth`.

Superseded PR runs are canceled; push/manual deployment runs stay serialized without
cancellation. Deploy triggers and credential gates remain specific to DAD-Main;
the ATM runner is validated offline and has no deployment job. Renaming `synth`
requires an accompanying ruleset change.

## Apply (one-time per branch)

These make live GitHub API calls. Run them yourself with the GitHub CLI authenticated
as an admin of `pre-dad/DAD-infra`; no workflow runs them.

`ruleset.json` (for `main`; for `dev`, change `name` and the `include` ref):

```json
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "synth" }]
      }
    },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ]
}
```

Create:

```sh
gh api -X POST repos/pre-dad/DAD-infra/rulesets --input ruleset.json
```

Update an existing ruleset (look up its id first):

```sh
id=$(gh api repos/pre-dad/DAD-infra/rulesets --jq '.[] | select(.name=="protect-main") | .id')
gh api -X PUT "repos/pre-dad/DAD-infra/rulesets/$id" --input ruleset.json
```

Set the default branch:

```sh
gh api -X PATCH repos/pre-dad/DAD-infra -f default_branch=main
```

## Verify

```sh
gh api repos/pre-dad/DAD-infra/rulesets --jq '.[] | {name, enforcement}'
gh api repos/pre-dad/DAD-infra --jq .default_branch
```

Both rulesets should be `active` and the default branch `main`. To inspect a ruleset in
full (read-only), run `gh api repos/pre-dad/DAD-infra/rulesets/<id>` and check
`bypass_actors` is `[]`.

## When collaborators join

Raise `required_approving_review_count` to 1 in both rulesets. There is no bypass today; if
an emergency escape hatch is wanted, add one deliberately to `bypass_actors` and record it
here.
