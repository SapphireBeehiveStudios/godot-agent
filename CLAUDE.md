# Claude Code Context for Sapphire Bee

Secure, sandboxed Docker environment for running Claude Code with development projects.

## What This Is

A Docker-based sandbox that isolates Claude Code with:
- **Network allowlisting**: Only GitHub and Anthropic API accessible
- **Filesystem isolation**: Only `/project` is writable
- **Security hardening**: Read-only rootfs, dropped capabilities, resource limits

Security is enforced by the container, not Claude's permission system. All Claude permissions are pre-granted.

## Quick Start

```bash
# First time setup
make doctor                    # Check prerequisites
make auth                      # Verify authentication
make install-hooks             # Install git hooks
docker pull ghcr.io/sapphirebeehivestudios/sapphire-bee:latest
docker tag ghcr.io/sapphirebeehivestudios/sapphire-bee:latest sapphire-bee:latest
make up                        # Start infrastructure

# Daily workflow (persistent mode - recommended)
make up-agent PROJECT=~/my-project
make claude                    # Interactive session
make claude P="your prompt"    # Single prompt
make down-agent               # When done

# Worker pool (process GitHub issues)
make pool-start REPO=owner/repo WORKERS=6
make pool-status              # Check status
make pool-health              # Health check
make pool-logs                # View logs
make pool-stop                # Stop all workers
```

## Key Commands

| Command | Description |
|---------|-------------|
| `make build` | Build agent image (only if modifying Dockerfile) |
| `make up` | Start infrastructure (DNS + proxies) |
| `make up-agent PROJECT=...` | Start persistent agent |
| `make claude` | Interactive Claude session |
| `make claude-print P="..."` | Non-interactive mode (for scripts) |
| `make pool-start REPO=... WORKERS=N` | Start worker pool |
| `make pool-health` | Check worker pool health |
| `make test-security` | Run security tests |
| `make ci` | Test CI locally (requires `act`) |

## Two Operating Contexts

| Context | You Are | File | Auth Method |
|---------|---------|------|-------------|
| **Host** | Developer managing infrastructure | This file | `gh` CLI + git SSH |
| **Sandboxed Agent** | Claude inside container | `/project/.claude/sandbox-context.md` | MCP tools only |

**Inside container?** Use MCP tools for GitHub (NOT `gh` CLI). Git CLI is fine for local operations.

## Architecture Essentials

```
┌─────────────────────────────────────────────────────────┐
│  sandbox_net (10.100.1.0/24) - INTERNAL, NO INTERNET    │
│                                                          │
│  ┌──────────────┐                  ┌─────────────────┐  │
│  │  dnsfilter   │◄────DNS─────────│  agent/workers  │  │
│  │  10.100.1.2  │                  │  10.100.1.100+  │  │
│  └──────────────┘                  └─────────────────┘  │
│         │ returns proxy IPs                 │           │
│         ▼                                    │           │
│  Proxies (nginx TCP forwarding)  ◄──────────┘           │
│  10.100.1.10  proxy_github                               │
│  10.100.1.11  proxy_raw_githubusercontent                │
│  10.100.1.14  proxy_anthropic_api                        │
│         │                                                │
└─────────┼────────────────────────────────────────────────┘
          │ egress_net - HAS INTERNET
          ▼
     INTERNET (only allowed domains)
```

## Worker Pool (Phase-Based Workflow)

Workers follow a maintenance-first approach:

1. **PHASE 1 (Maintain)**: Check own PRs for problems
   - Failing CI → Auto-fix (go mod tidy, pre-commit)
   - Merge conflicts → Auto-rebase
   - Fix ALL problems before claiming new work

2. **PHASE 2 (Limit)**: Enforce work limits
   - Max 3 open PRs per worker (configurable)
   - Prevents PR accumulation

3. **PHASE 3 (Create)**: Claim new issues
   - Only when all PRs are healthy
   - Only when under PR limit

**Configuration** (`.env`):
```bash
MAX_OPEN_PRS=10               # Work limit per worker
AUTO_FIX_CONFLICTS=true       # Auto-rebase merge conflicts
AUTO_FIX_GO_MOD=true          # Auto-fix go mod issues
AUTO_FIX_PRECOMMIT=true       # Auto-fix pre-commit failures
```

## Critical Security Notes

### GitHub App vs Personal Auth

**Host (outside container):**
- Use `gh` CLI with your personal credentials
- Full access to all GitHub features

**Sandboxed agents (inside container):**
- **ONLY use MCP tools** for GitHub operations
- GitHub App token (auto-refreshed, ~1 hour expiry)
- **NO `gh` CLI** - won't work, don't try
- **NO workflow file edits** - GitHub App lacks `workflows` scope

If agent encounters CI/CD work → Add `needs-human-review` label + comment explaining why.

### Branch Protection

Pre-push hook blocks direct pushes to `main`/`master`. Workers must:
1. Create `claude/*` branches
2. Push to branch
3. Use MCP `create_pull_request` tool
4. Wait for human merge

## Go Version Requirement

**Always use Go 1.24.0 or later.** This is REQUIRED for security:
- **CVE-2025-61729**: crypto/x509 certificate validation vulnerability
- **CVE-2025-61727**: crypto/x509 certificate chain verification flaw

Workers are pre-configured with Go 1.24. If you see Go 1.22 in CI files → upgrade to 1.24.

## Common Patterns

### Committing Changes

```bash
# Workers do this automatically, but for reference:
git add -A
git commit -m "feat: description

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push origin branch-name
```

### Creating PRs

Use MCP tools (inside container):
```javascript
// NOT: gh pr create
// USE: create_pull_request MCP tool
{
  owner: "owner",
  repo: "repo",
  title: "Fix: issue title",
  body: "## Fixes #123\n\n...",
  head: "claude/issue-123-...",
  base: "main"
}
```

### Python Package Management

**Always use `uv` instead of `pip`:**
```bash
uv pip install package      # Not: pip install
uv venv                     # Not: python -m venv
uv run script.py            # Run with dependencies
```

## File Structure

```
sapphire-bee/
├── compose/                 # Docker Compose configs
│   ├── compose.base.yml     # Infrastructure (DNS + proxies)
│   ├── compose.persistent.yml # Persistent agent
│   ├── compose.pool.yml     # Worker pool
│   └── compose.queue.yml    # Queue processor
├── configs/
│   ├── coredns/             # DNS allowlist
│   └── nginx/               # Proxy configs
├── docs/                    # Detailed documentation
│   ├── SETUP.md             # First-time setup guide
│   ├── WORKFLOW_GUIDE.md    # Detailed workflows
│   ├── TROUBLESHOOTING.md   # Common issues
│   └── LOGS.md              # Logging guide
├── image/
│   ├── Dockerfile           # Agent image
│   ├── config/
│   │   ├── claude-settings.json  # Permissions (all granted)
│   │   └── sandbox-context.md    # Agent context file
│   └── scripts/
│       ├── entrypoint.sh    # Container setup
│       └── issue-worker.js  # Worker pool script
├── tests/                   # Security test suite (pytest)
└── scripts/                 # Operational scripts
```

## Common Issues

| Issue | Solution |
|-------|----------|
| DNS not working | `make restart` |
| Worker out of space | `docker exec worker-N df -h /home/claude` (tmpfs is 1GB) |
| Worker stuck | `make pool-health-restart` |
| Auth errors | `make auth` to diagnose |
| Image too old | `docker pull ghcr.io/...` then restart workers |

## Detailed Documentation

- **First-time setup**: `docs/SETUP.md`
- **Workflows**: `docs/WORKFLOW_GUIDE.md`
- **Troubleshooting**: `docs/TROUBLESHOOTING.md`
- **Logging**: `docs/LOGS.md`
- **Architecture**: See network diagram above + `compose/*.yml`
- **Agent context**: `image/config/sandbox-context.md`

## Development Workflow

```bash
# 1. Make changes to code
vim image/scripts/issue-worker.js

# 2. Rebuild image
make build

# 3. Test locally
make test-security

# 4. Test in CI (if you have act)
make ci

# 5. Commit with hooks
git add -A && git commit -m "feat: description"
# Pre-commit hooks run automatically

# 6. Push and create PR
git push origin branch-name
gh pr create --title "..." --body "..."
```

## Environment Variables

Set in `.env` file:

```bash
# Authentication (required)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...     # From: claude setup-token
# OR
ANTHROPIC_API_KEY=sk-ant-...           # Pay-per-use

# GitHub App (required for workers)
GITHUB_APP_ID=your_app_id
GITHUB_APP_INSTALLATION_ID=your_installation_id
GITHUB_APP_PRIVATE_KEY_PATH=/secrets/your-app.private-key.pem

# Worker Pool
GITHUB_REPO=owner/repo                 # Repository to work on
ISSUE_LABEL=agent-ready                # Label to filter issues
MAX_OPEN_PRS=3                         # Work limit per worker
POLL_INTERVAL=60                       # Seconds between polls

# Auto-Fix (default: true)
AUTO_FIX_CONFLICTS=true
AUTO_FIX_GO_MOD=true
AUTO_FIX_PRECOMMIT=true
```

## Pre-commit Hooks

Git hooks are auto-installed when workers clone repos. They check for:
- Secrets (API keys, tokens)
- Shell script linting (shellcheck)
- Branch protection (blocks push to main/master)

To install locally: `make install-hooks`

## Pre-built Image

Workers use the pre-built image from GitHub Container Registry:
```
ghcr.io/sapphirebeehivestudios/sapphire-bee:latest
```

**Available tags**:
- `:latest` - Most recent build from main
- `:claude-X.Y.Z` - Tagged by Claude Code version
- `:YYYYMMDD` - Tagged by build date
- `:sha-XXXXXX` - Tagged by git commit

**Only rebuild locally if modifying the Dockerfile.** Otherwise, pull from registry.

## Getting Help

- `/help` in Claude Code CLI
- Report issues: https://github.com/anthropics/claude-code/issues (for Claude Code)
- Report sandbox issues: Create issue in this repo
- View logs: `make logs` (infrastructure) or `make pool-logs` (workers)
- Check health: `make status` or `make pool-health`
