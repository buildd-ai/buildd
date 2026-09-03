# Setting Up NO_PROD_DATA_IDENTIFIERS Secret

## Overview

The `.github/workflows/no-prod-data.yml` check requires a GitHub Actions repository secret called `NO_PROD_DATA_IDENTIFIERS` to function. This secret contains an ERE (Extended Regular Expression) alternation of sensitive identifiers that should never be committed to this public repository.

## Who Can Do This

Only GitHub repository **administrators** can create or modify repository secrets. This is a security feature by design — the secret's contents are sensitive, and non-admins should not have access.

## Step-by-Step Setup

### 1. Navigate to Repository Secrets
1. Go to the GitHub repository: https://github.com/buildd-ai/buildd
2. Click **Settings** (top-right menu)
3. In the left sidebar, click **Secrets and variables** → **Actions**

### 2. Create the Secret
1. Click **New repository secret**
2. Name: `NO_PROD_DATA_IDENTIFIERS` (exactly)
3. Value: An ERE alternation (see **Value Format** below)
4. Click **Add secret**

### 3. Verify Setup
After creating the secret, push a commit or create a PR. The `check` job in `.github/workflows/no-prod-data.yml` will:
- Pass if no sensitive identifiers are detected in the diff, title, body, or commit messages
- Fail with specific line numbers if identifiers are found

## Value Format

The secret must contain an ERE (Extended Regular Expression) alternation. Format: `handle1|handle2|privateRepoName|etc`

### What to Include

**Personal handles / usernames:**
- Individual GitHub usernames of team members (anchored if short/common)
  - Example: `\bmax\b` (anchored) vs. `alice-smith` (unlikely to cause false positives)
- Slack handles, email prefixes

**Private repository names:**
- Names of private repos your team maintains
- Anchored if short or common words: `\bcore\b` instead of `core`

### Example Value

```
\bmax\b|\bwu\b|\balice-smith\b|buildd-infrastructure|buildd-internal-docs
```

### Important Guidelines

1. **Anchor short/common words** with `\b` (word boundary):
   - ❌ `max` matches `Math.max()` and `maxWorkers`
   - ✅ `\bmax\b` matches only the standalone word "max"

2. **Don't anchor less common combinations**:
   - `alice-smith` doesn't need anchoring
   - `my-private-repo` doesn't need anchoring

3. **Use pipe `|` to separate alternations**:
   - ✅ `\bmax\b|\bwu\b|my-repo`
   - ❌ `\bmax\b \bwu\b my-repo` (spaces don't work in ERE)

## Testing Locally

Before setting the secret, test the regex pattern locally:

```bash
# Test that your pattern correctly matches an identifier
python3 scripts/__tests__/check_no_prod_data_test.py

# Test the main script with a mock secret (in bash)
export NO_PROD_DATA_IDENTIFIERS="\bmax\b|\balice\b"
python3 scripts/check_no_prod_data.py origin/dev --body /tmp/test.txt --title /tmp/test.txt
```

## What the Secret Does

Once set, the `NO_PROD_DATA_IDENTIFIERS` secret is used by `scripts/check_no_prod_data.py` to:
- Scan PR titles, bodies, and commit messages for identifiers
- Scan newly added code lines for identifiers
- Block PRs if any matches are found

The check will NOT fail on empty matches — only on real sensitive data.

## False Positives

If a legitimate code change matches the regex (e.g., a function named `max_workers` when `\bmax\b` is in the pattern), you can suppress the check for that PR:

Add to the PR body:
```
no-prod-data: allow reason for suppression here
```

This suppresses count/UUID rules but identifier checks still apply.

## Troubleshooting

### Workflow Still Fails After Setting Secret

1. Verify the secret name is **exactly** `NO_PROD_DATA_IDENTIFIERS` (case-sensitive)
2. Verify it's set under **Actions** secrets, not **Dependabot** secrets
3. Wait a few minutes for GitHub to propagate the secret
4. Push a new commit or rerun the workflow

### Pattern Not Matching

- Check ERE syntax. GitHub Actions uses standard POSIX ERE.
- Test locally with the Python script
- Verify `\b` (word boundaries) are used correctly

### Need to Update the Secret

Admins can edit the secret by:
1. Going to Settings → Secrets and variables → Actions
2. Clicking the secret
3. Clicking **Update**
4. Changing the value
5. Clicking **Update secret**

The new value applies immediately to the next run.

## References

- Workflow file: `.github/workflows/no-prod-data.yml`
- Check script: `scripts/check_no_prod_data.py`
- Related CLAUDE.md section: "This Repo Is Public"
- GitHub Secrets documentation: https://docs.github.com/en/actions/security-guides/encrypted-secrets
