# GitHub App Setup for Sapphire Bee

This guide explains how to set up GitHub App authentication for the Sapphire Bee sandbox. GitHub Apps provide **short-lived tokens** with fine-grained permissions, offering better security than Personal Access Tokens (PATs).

## Why GitHub App Instead of PAT?

| Feature | GitHub App | Personal Access Token |
|---------|------------|----------------------|
| Token lifetime | 1 hour (auto-expires) | Up to 1 year |
| Scope control | Per-repository | All accessible repos |
| Audit trail | Shows as "github-app/your-app" | Shows as your username |
| Rate limits | Higher (per installation) | Shared with your account |
| Revocation | Tokens auto-expire | Must manually revoke |

## Quick Start

```bash
# 1. Create GitHub App (see detailed instructions below)
# 2. Download private key to ./secrets/

# 3. Add configuration to .env
cat >> .env << 'EOF'
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem
EOF

# 4. Test the configuration
make github-app-test

# 5. Start the agent
make up-agent PROJECT=/path/to/your/project
```

## Step 1: Create a GitHub App

1. Go to **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
   - URL: https://github.com/settings/apps/new

2. Fill in the basic information:
   - **GitHub App name**: `sapphire-bee` (or your preferred name)
   - **Homepage URL**: Your repository URL
   - **Webhook**: Uncheck "Active" (we don't need webhooks)

3. Set **Permissions** based on what the agent needs:

   **For read-only access (safer):**
   | Permission | Access Level | Purpose |
   |------------|--------------|---------|
   | Contents | Read | Read code, assets, configs |
   | Metadata | Read | Required (auto-included) |

   **For full development workflow:**
   | Permission | Access Level | Purpose |
   |------------|--------------|---------|
   | Contents | Read & Write | Clone, commit, push code |
   | Issues | Read & Write | Create/close issues |
   | Pull requests | Read & Write | Create/merge PRs |
   | Metadata | Read | Required (auto-included) |

4. Under "Where can this GitHub App be installed?":
   - Select **Only on this account** (recommended for personal use)
   - Or **Any account** if you'll share across organizations

5. Click **Create GitHub App**

## Step 2: Generate Private Key

1. After creating the app, scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file will download automatically
4. Move it to your secrets directory:
   ```bash
   mkdir -p secrets/
   mv ~/Downloads/your-app-name.*.private-key.pem secrets/github-app-private-key.pem
   chmod 600 secrets/github-app-private-key.pem
   ```

## Step 3: Install the App

1. Go to your GitHub App's page:
   - Settings → Developer settings → GitHub Apps → Your App
   
2. Click **Install App** in the left sidebar

3. Choose where to install:
   - **All repositories** - Access to all repos in the account/org
   - **Only select repositories** - Choose specific repos (recommended)

4. Click **Install**

5. Note the **Installation ID** from the URL:
   ```
   https://github.com/settings/installations/12345678
                                              ^^^^^^^^
                                              This is your Installation ID
   ```

## Step 4: Configure the Agent

### Option A: Using PEM File (Local Development)

Store the private key as a file:

```bash
# .env file
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem
```

### Option B: Using Base64 (CI/CD & Secure Environments)

Encode the key as base64 for environment variables:

```bash
# Generate base64-encoded key
base64 -i ./secrets/github-app-private-key.pem | tr -d '\n' > key.b64

# Add to .env
echo "GITHUB_APP_PRIVATE_KEY=$(cat key.b64)" >> .env

# Clean up
rm key.b64
```

### Option C: Scope to Specific Repositories

Limit the token to specific repos:

```bash
# .env file
GITHUB_APP_REPOSITORIES=my-project,project-assets
```

## Step 5: Test the Configuration

```bash
# Full validation (generates token, tests API access)
make github-app-test

# Quick validation (checks config only)
make github-app-validate

# Test with specific repositories
make github-app-test REPOS="my-game another-game"
```

Expected output:
```
============================================================
  GitHub App Credential Validation
============================================================

  App ID:          123456
  Private Key:     ./secrets/github-app-private-key.pem
  Installation ID: 12345678

============================================================
  Step 1: Validating GitHub App Credentials
============================================================

  ✅ App authenticated successfully!
  ℹ️  App Name: sapphire-bee
  ℹ️  Configured permissions:
      - contents: read
      - issues: write
      - pull_requests: write

============================================================
  Step 2: Generating Installation Token
============================================================

  ✅ Installation token generated successfully!
  ℹ️  Token prefix: ghs_xxxxxxxxxxxx...
  ℹ️  Expires at: 2024-01-15T12:00:00Z
  ℹ️  Valid for: 59 minutes

============================================================
  Step 3: Testing GitHub API Access
============================================================

  ✅ API access working! Found 3 accessible repositories.
  ℹ️  Accessible repositories:
      📂 my-org/my-project
      🔒 my-org/project-assets
      📂 my-org/project-tools

============================================================
  Summary
============================================================

  ✅ All tests passed!
```

## Usage with the Agent

Once configured, the agent automatically:

1. **On startup**: Generates a fresh installation token
2. **Configures MCP**: Creates MCP config with the token for the GitHub server
3. **Sets up git**: Configures git credentials for clone/push operations
4. **Branch protection**: Blocks direct pushes to main/master

Inside the container, you can use:

```bash
# Clone repositories
git clone https://github.com/your-org/your-repo.git

# Use GitHub CLI
gh issue list
gh pr create

# Claude can use GitHub MCP tools
# (automatically available via MCP config)
```

## Token Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                      Token Lifecycle                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Container Start                                             │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────┐                                        │
│  │ Generate JWT    │ ← Private key signs JWT                │
│  │ (valid 10 min)  │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ Exchange for    │ ← GitHub API returns token            │
│  │ Install Token   │                                        │
│  │ (valid 1 hour)  │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ Configure MCP   │ ← Token passed to MCP server          │
│  │ + Git + gh CLI  │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ Agent Session   │ ← Token works for ~1 hour             │
│  │ (use normally)  │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  Token expires (no action needed - container restarts get   │
│  fresh token)                                                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Session Duration Considerations

Installation tokens expire after **1 hour**. For typical agent sessions:

- **Short sessions (< 1 hour)**: No issues, token remains valid
- **Long sessions**: Consider restarting the container to get a fresh token

For long-running queue mode, the token will expire. Options:
1. Keep sessions short (< 1 hour per task)
2. Restart the container periodically
3. Implement token refresh (future enhancement)

## Troubleshooting

### "Private key not found"

```bash
# Check file exists
ls -la secrets/github-app-private-key.pem

# Verify permissions
chmod 600 secrets/github-app-private-key.pem
```

### "Failed to generate installation token"

1. Verify Installation ID is correct:
   - Go to Settings → Applications → Installed GitHub Apps
   - Click "Configure" on your app
   - Note the ID from the URL

2. Check the app is installed on the target repositories

### "API request failed with status 401"

1. Verify App ID matches your GitHub App
2. Check private key hasn't been rotated
3. Generate a new private key if needed

### "No accessible repositories"

1. Check the app's installation includes your repositories
2. Verify "Repository access" settings in the installation

### Token expires during long sessions

Currently, tokens are generated once at container startup. For sessions longer than 1 hour:

```bash
# Stop and restart the agent
make down-agent
make up-agent PROJECT=/path/to/project
```

## Security Best Practices

1. **Never commit private keys**
   - The `secrets/` directory and `*.pem` files are gitignored
   - For CI/CD, use repository secrets

2. **Use minimal permissions**
   - Only grant the permissions the agent actually needs
   - Start with read-only and add write permissions as needed

3. **Scope to specific repositories**
   - Set `GITHUB_APP_REPOSITORIES` to limit access
   - Prefer "Only select repositories" during app installation

4. **Rotate keys periodically**
   - Generate new private keys every 90 days
   - Delete old keys from GitHub App settings

5. **Monitor usage**
   - Check Security → Code security and analysis for audit logs
   - API calls show as your GitHub App, not your personal account

## Comparison: GitHub App vs PAT for Sapphire Bee

| Scenario | Recommendation |
|----------|----------------|
| Personal development | Either works, App is more secure |
| Team/Organization | GitHub App (centralized control) |
| CI/CD pipelines | GitHub App (no personal tokens in CI) |
| Long-running agents | Either (tokens expire similarly) |
| Multiple repos | GitHub App (installation-wide) |
| Quick testing | PAT (faster to set up) |

## Related Documentation

- [GitHub Apps Documentation](https://docs.github.com/en/apps/creating-github-apps)
- [GitHub App Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [MCP Specification](https://modelcontextprotocol.io)



