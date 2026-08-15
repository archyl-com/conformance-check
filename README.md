# Archyl Conformance Check GitHub Action

Run architecture conformance rules against changed files in your CI pipeline. Annotates violations directly on pull requests and blocks merges when rules are violated.

## Usage

### On every pull request

```yaml
on:
  pull_request:
    branches: [main]

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: archyl-com/actions/conformance-check@v1
        with:
          api-key: ${{ secrets.ARCHYL_API_KEY }}
          organization-id: ${{ secrets.ARCHYL_ORG_ID }}
          project-id: 'your-project-uuid'
```

### Block PRs on errors (default behavior)

```yaml
- uses: archyl-com/actions/conformance-check@v1
  with:
    api-key: ${{ secrets.ARCHYL_API_KEY }}
    organization-id: ${{ secrets.ARCHYL_ORG_ID }}
    project-id: 'your-project-uuid'
    fail-on: 'error' # Fail on error-level violations only (default)
```

### Strict mode — fail on warnings too

```yaml
- uses: archyl-com/actions/conformance-check@v1
  with:
    api-key: ${{ secrets.ARCHYL_API_KEY }}
    organization-id: ${{ secrets.ARCHYL_ORG_ID }}
    project-id: 'your-project-uuid'
    fail-on: 'warning'
```

### Report only — never fail

```yaml
- uses: archyl-com/actions/conformance-check@v1
  with:
    api-key: ${{ secrets.ARCHYL_API_KEY }}
    organization-id: ${{ secrets.ARCHYL_ORG_ID }}
    project-id: 'your-project-uuid'
    fail-on: 'none'
```

### Disable PR comments

```yaml
- uses: archyl-com/actions/conformance-check@v1
  with:
    api-key: ${{ secrets.ARCHYL_API_KEY }}
    organization-id: ${{ secrets.ARCHYL_ORG_ID }}
    project-id: 'your-project-uuid'
    comment-on-pr: 'false'
```

### Combined with drift score

```yaml
jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Conformance check
        uses: archyl-com/actions/conformance-check@v1
        with:
          api-key: ${{ secrets.ARCHYL_API_KEY }}
          organization-id: ${{ secrets.ARCHYL_ORG_ID }}
          project-id: 'your-project-uuid'

      - name: Drift score
        uses: archyl-com/actions/drift-score@v1
        with:
          api-key: ${{ secrets.ARCHYL_API_KEY }}
          organization-id: ${{ secrets.ARCHYL_ORG_ID }}
          project-id: 'your-project-uuid'
          threshold: '70'
```

## How It Works

1. **Detects changed files** from the pull request or push event via the GitHub API
2. **Reads file contents** (first 200 lines per file — imports, types, signatures)
3. **Sends the diff to Archyl** in a single call, which runs the conformance rules and returns the full report
4. **Creates annotations** on the exact files where violations occur
5. **Comments on the PR** with a summary table of all violations
6. **Fails the check** if violations exceed the configured severity threshold

## Severity Levels

Archyl grades violations `critical`, `high`, `medium`, and `low`. The action reports them
on the scale that `fail-on` and the outputs use:

| Archyl severity | Action level |
|---|---|
| `critical`, `high` | `error` |
| `medium` | `warning` |
| `low` | `info` |

So the default `fail-on: error` blocks a PR on exactly the violations Archyl itself
counts as a failed check.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | Yes | | Archyl API key with write scope |
| `organization-id` | Yes | | Archyl organization UUID |
| `project-id` | Yes | | Archyl project UUID |
| `api-url` | No | `https://api.archyl.com` | API base URL (for self-hosted) |
| `fail-on` | No | `error` | Minimum severity that fails: `error`, `warning`, or `none` |
| `comment-on-pr` | No | `true` | Post a summary comment on the PR |
| `github-token` | No | `${{ github.token }}` | Token for PR comments and file listing |
| `max-file-lines` | No | `200` | Max lines to send per file (reduces token usage) |
| `chunk-size` | No | `20` | Deprecated and ignored — the whole diff is sent in one call |

## Outputs

| Output | Description |
|---|---|
| `check-id` | UUID of the conformance check |
| `total-violations` | Total violations found |
| `errors` | Error-level violations |
| `warnings` | Warning-level violations |
| `infos` | Info-level violations |
| `status` | `pass` or `fail` |

## PR Comment

The action posts (or updates) a comment on the pull request with a table of violations:

| Severity | Rule | File | Message |
|----------|------|------|---------|
| :red_circle: critical | No Direct DB Access | `handlers/user.go` | Handler directly imports database package — call the repository instead |
| :orange_circle: medium | OpenAPI Required | `services/payment.go` | Service has no linked API contract — attach an OpenAPI spec |

## Annotations

Violations are also shown as GitHub annotations directly on the changed files in the PR diff, making it easy to see exactly where the architecture rules are violated.

## Job Summary

A detailed summary is written to the GitHub Actions job summary with the full violation report.
