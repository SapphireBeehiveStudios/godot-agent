# GitHub App MCP Integration

This document describes the implementation of GitHub App authentication with MCP (Model Context Protocol) integration for the sandboxed Sapphire Bee agent.

## Overview

The integration replaces long-lived Personal Access Tokens (PATs) with short-lived GitHub App installation tokens, providing better security for the sandboxed Claude agent's GitHub access.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Token Flow                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Container Start                                                            │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Generate JWT (signed with private key)                          │   │
│   │     - Valid for 10 minutes                                          │   │
│   │     - Used only to request installation token                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  2. Exchange JWT for Installation Token (via api.github.com)        │   │
│   │     - Valid for 1 hour                                              │   │
│   │     - Optionally scoped to specific repositories                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  3. Configure Agent                                                 │   │
│   │     - Set GITHUB_TOKEN for git operations                           │   │
│   │     - Set GH_TOKEN for GitHub CLI                                   │   │
│   │     - Create MCP config with token for GitHub MCP server            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│        │                                                                     │
│        ▼                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  4. Agent Session                                                   │   │
│   │     - Git clone/push via HTTPS with token auth                      │   │
│   │     - GitHub CLI (gh) commands                                      │   │
│   │     - MCP tools (get_file_contents, create_issue, etc.)            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Architecture

### New Components

```
sapphire-bee/
├── github_app/                          # Python module for token generation
│   ├── __init__.py                      # Package exports
│   ├── token_generator.py               # GitHubAppTokenGenerator class
│   ├── mcp_config.py                    # MCPConfigGenerator class
│   └── test_github_app.py               # Credential validation script
│
├── image/
│   ├── config/
│   │   └── sandbox-context.md           # Agent context (copied to ~/.claude/CLAUDE.md)
│   └── scripts/
│       └── setup-github-app.sh          # Token generation at container start
│
├── configs/
│   ├── nginx/
│   │   └── proxy_github_api.conf        # NEW: Proxy for api.github.com
│   └── coredns/
│       ├── Corefile                     # Updated: Added api.github.com
│       └── hosts.allowlist              # Updated: Added api.github.com mapping
│
├── compose/
│   ├── compose.base.yml                 # Updated: Added proxy_github_api service
│   ├── compose.direct.yml               # Updated: GitHub App env vars
│   ├── compose.persistent.yml           # Updated: GitHub App env vars
│   └── compose.queue.yml                # Updated: GitHub App env vars
│
├── secrets/                             # NEW: Directory for private keys
│   └── .gitkeep
│
└── docs/
    └── GITHUB_APP_SETUP.md              # Setup guide for users
```

### Network Changes

Added `api.github.com` to the allowlist for GitHub API access:

```
┌─────────────────────────────────────────────────────────────────┐
│  sandbox_net (10.100.1.0/24)                                    │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │  Agent          │    │  proxy_github   │──→ github.com      │
│  │  10.100.1.100   │    │  10.100.1.10    │                    │
│  │                 │    └─────────────────┘                    │
│  │  DNS queries    │    ┌─────────────────┐                    │
│  │       │         │    │proxy_github_api │──→ api.github.com  │
│  │       ▼         │    │  10.100.1.15    │    (NEW)           │
│  │  ┌──────────┐   │    └─────────────────┘                    │
│  │  │dnsfilter │   │                                           │
│  │  │10.100.1.2│   │    ┌─────────────────┐                    │
│  │  └──────────┘   │    │proxy_anthropic  │──→ api.anthropic   │
│  │                 │    │  10.100.1.14    │                    │
│  └─────────────────┘    └─────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. Token Generator (`github_app/token_generator.py`)

The `GitHubAppTokenGenerator` class handles:

```python
class GitHubAppTokenGenerator:
    def generate_jwt(self) -> str:
        """Generate JWT signed with app's private key (valid 10 min)"""
    
    def generate_installation_token(
        self,
        repositories: Optional[list[str]] = None,
        permissions: Optional[dict[str, str]] = None
    ) -> dict:
        """Exchange JWT for installation token (valid 1 hour)"""
    
    def validate_credentials(self) -> dict:
        """Test credentials by fetching app info"""
```

### 2. MCP Configuration (`github_app/mcp_config.py`)

Generates Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@github/github-mcp-server"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<installation_token>"
      }
    }
  }
}
```

**⚠️ Important about `GITHUB_PERSONAL_ACCESS_TOKEN`:**

Despite its name, this is NOT a personal access token. The GitHub MCP server uses this environment variable name, but we populate it with a **GitHub App installation token**:

- Auto-generated on container startup from GitHub App credentials
- Expires after ~1 hour (refreshed on container restart)
- **FOR MCP TOOLS ONLY** - never extract this for `gh` CLI or other uses

The `gh` CLI is not installed in the sandbox. All GitHub operations should use MCP tools, which read this token automatically from `~/.claude.json`.

### 3. Container Startup (`image/scripts/setup-github-app.sh`)

At container start, the entrypoint:

1. Checks for GitHub App configuration (`GITHUB_APP_ID`, etc.)
2. Falls back to PAT authentication if no App configured
3. Generates JWT using Python + PyJWT
4. Exchanges JWT for installation token via GitHub API
5. Configures git credentials and MCP server
6. Sets up branch protection hooks

### 4. Agent Context (`image/config/sandbox-context.md`)

Provides the sandboxed Claude agent with:
- Environment overview (what's available, what's restricted)
- Network access information (allowlisted domains)
- Git/GitHub workflow guidance
- Development workflow instructions
- Security boundaries

This file is copied to `~/.claude/CLAUDE.md` at container start.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Installation ID |
| `GITHUB_APP_PRIVATE_KEY` | One of these | Base64-encoded private key |
| `GITHUB_APP_PRIVATE_KEY_PATH` | One of these | Path to PEM file |
| `GITHUB_APP_REPOSITORIES` | No | Comma-separated repo names to scope |

### Example `.env`

```bash
# GitHub App authentication
GITHUB_APP_ID=2587725
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem

# Optional: scope to specific repos
GITHUB_APP_REPOSITORIES=my-game,game-assets
```

## Security Improvements

| Aspect | PAT (Before) | GitHub App (After) |
|--------|--------------|-------------------|
| Token lifetime | Up to 1 year | 1 hour (auto-expires) |
| Scope control | All accessible repos | Per-repository scoping |
| Audit trail | Shows as user | Shows as "github-app/name" |
| Credential storage | Long-lived token in env | Only private key stored |
| Revocation | Manual | Automatic expiration |

## Dependencies Added

### Container (Dockerfile)

```dockerfile
# Python for JWT generation
python3

# uv for package management (faster than pip)
curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Python packages
uv pip install --system PyJWT cryptography requests
```

### Tests (`tests/requirements.txt`)

```
PyJWT>=2.8.0
cryptography>=42.0.0
requests>=2.31.0
```

## Makefile Targets

```bash
# Test GitHub App credentials (generates token, tests API)
make github-app-test

# Quick validation (checks config only)
make github-app-validate

# Test with specific repositories
make github-app-test REPOS="my-game another-game"
```

## Token Lifecycle Considerations

Installation tokens expire after **1 hour**. Current handling:

| Session Type | Duration | Token Handling |
|--------------|----------|----------------|
| Short sessions | < 1 hour | No refresh needed |
| Interactive | Variable | Restart container for new token |
| Queue mode | Long-running | Tasks should complete within 1 hour |

**Future enhancement:** Implement token refresh for long-running sessions.

## Testing

### Validation Script

```bash
# Full validation flow
python -m github_app.test_github_app \
    --app-id 123456 \
    --private-key ./secrets/github-app-private-key.pem \
    --installation-id 12345678

# Or use environment variables
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem
export GITHUB_APP_INSTALLATION_ID=12345678
make github-app-test
```

### What's Tested

1. ✅ JWT generation with private key
2. ✅ App credential validation
3. ✅ Installation token generation
4. ✅ GitHub API access with token
5. ✅ MCP configuration generation

## Troubleshooting

### "Private key not found"

```bash
ls -la secrets/github-app-private-key.pem
chmod 600 secrets/github-app-private-key.pem
```

### "Failed to generate installation token"

- Verify Installation ID from: `https://github.com/settings/installations`
- Check app is installed on target repositories

### "PyJWT not installed"

The container should have PyJWT pre-installed. If not:
```bash
uv pip install --system PyJWT cryptography
```

### Token expires during session

Restart the container to get a fresh token:
```bash
make down-agent
make up-agent PROJECT=/path/to/project
```

## Files Modified

| File | Changes |
|------|---------|
| `image/Dockerfile` | Added Python 3, uv, PyJWT; copy sandbox-context.md |
| `image/scripts/entrypoint.sh` | GitHub App setup, sandbox context copy |
| `compose/compose.*.yml` | Added GitHub App env vars |
| `configs/coredns/Corefile` | Added api.github.com |
| `configs/coredns/hosts.allowlist` | Added api.github.com → proxy |
| `.gitignore` | Added *.pem, secrets/ |
| `tests/requirements.txt` | Added PyJWT, cryptography, requests |
| `Makefile` | Added github-app-test, github-app-validate |
| `README.md` | Added GitHub App documentation |

## Related Documentation

- [GitHub App Setup Guide](GITHUB_APP_SETUP.md) - User-facing setup instructions
- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [MCP Specification](https://modelcontextprotocol.io)



