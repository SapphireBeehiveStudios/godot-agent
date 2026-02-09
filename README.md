```
 ███████╗ █████╗ ██████╗ ██████╗ ██╗  ██╗██╗██████╗ ███████╗    ██████╗ ███████╗███████╗
 ██╔════╝██╔══██╗██╔══██╗██╔══██╗██║  ██║██║██╔══██╗██╔════╝    ██╔══██╗██╔════╝██╔════╝
 ███████╗███████║██████╔╝██████╔╝███████║██║██████╔╝█████╗      ██████╔╝█████╗  █████╗
 ╚════██║██╔══██║██╔═══╝ ██╔═══╝ ██╔══██║██║██╔══██╗██╔══╝      ██╔══██╗██╔══╝  ██╔══╝
 ███████║██║  ██║██║     ██║     ██║  ██║██║██║  ██║███████╗    ██████╔╝███████╗███████╗
 ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚══════╝    ╚═════╝ ╚══════╝╚══════╝
```

# Sapphire Bee Sandbox

[![CI](https://github.com/SapphireBeehiveStudios/sapphire-bee/actions/workflows/ci.yml/badge.svg)](https://github.com/SapphireBeehiveStudios/sapphire-bee/actions/workflows/ci.yml)
[![Build and Push](https://github.com/SapphireBeehiveStudios/sapphire-bee/actions/workflows/build-and-push.yml/badge.svg)](https://github.com/SapphireBeehiveStudios/sapphire-bee/actions/workflows/build-and-push.yml)

A secure, sandboxed environment for running Claude Code with development projects. Run Claude in isolated containers with network allowlisting, filesystem isolation, and security hardening.

**Key Features:**
- **Worker Pool Mode** - Run multiple autonomous agents processing GitHub issues in parallel
- **Build Tools** - Pre-installed Go, Python, Node.js, and build essentials
- **Package Manager Access** - Allowlisted network access to golang.org, pypi.org, npm registry
- **Network Isolation** - DNS-based allowlisting with nginx stream proxies
- **Multiple Operating Modes** - Persistent, isolated, pool, queue, and one-shot modes

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HOST (Trusted)                                 │
│  ┌──────────────┐  ┌──────────────────────────────────────────────────────┐ │
│  │  Your IDE    │  │              Docker Desktop                          │ │
│  │   (macOS)    │  │  ┌─────────────────────────────────────────────────┐ │ │
│  │              │  │  │              egress_net (Internet)              │ │ │
│  └──────────────┘  │  │    ┌────────────────────────────────────────┐   │ │ │
│         │          │  │    │            PROXY LAYER                 │   │ │ │
│         │          │  │    │  ┌─────────┐ ┌─────────┐ ┌──────────┐  │   │ │ │
│         │          │  │    │  │ proxy_  │ │ proxy_  │ │ proxy_   │  │   │ │ │
│         │          │  │    │  │ github  │ │ raw_    │ │anthropic │  │   │ │ │
│         │          │  │    │  │         │ │ github  │ │ _api     │  │   │ │ │
│         │          │  │    │  └────┬────┘ └────┬────┘ └────┬─────┘  │   │ │ │
│         │          │  │    └───────┼──────────┼────────────┼────────┘   │ │ │
│         │          │  └────────────┼──────────┼────────────┼────────────┘ │ │
│         │          │  ┌────────────┼──────────┼────────────┼────────────┐ │ │
│         │          │  │  sandbox_net (Internal, No Internet)            │ │ │
│         │          │  │    ┌───────┴──────────┴────────────┴───────┐    │ │ │
│         │          │  │    │             AGENT CONTAINER           │    │ │ │
│         │          │  │    │  ┌──────────────┐                     │    │ │ │
│         │          │  │    │  │ Claude Code  │                     │    │ │ │
│         │          │  │    │  │     CLI      │                     │    │ │ │
│  ┌──────┴───────┐  │  │    │  └──────────────┘                     │    │ │ │
│  │   /project   │◄─┼──┼────┼───────────┐                           │    │ │ │
│  │ (Your code)  │  │  │    │           │  /project (mount)         │    │ │ │
│  └──────────────┘  │  │    └───────────┴───────────────────────────┘    │ │ │
│                    │  │                        │                        │ │ │
│  Trust Boundary ═══╪══╪═════════════════════════════════════════════════╪ │ │
│       ▼            │  │    ┌───────────────────┴───────────────────┐    │ │ │
│                    │  │    │              dnsfilter                │    │ │ │
│                    │  │    │              (CoreDNS)                │    │ │ │
│                    │  │    │   Allowlist → proxy IPs               │    │ │ │
│                    │  │    │   Block all → NXDOMAIN                │    │ │ │
│                    │  │    └───────────────────────────────────────┘    │ │ │
│                    │  └─────────────────────────────────────────────────┘ │ │
│                    └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   INTERNET (Untrusted)│
                          │  - GitHub             │
                          │  - Anthropic API      │
                          │  - golang.org         │
                          │  - pypi.org           │
                          └───────────────────────┘
```

### Trust Boundaries

| Zone | Trust Level | Access |
|------|-------------|--------|
| Host | Trusted | Full system access |
| Agent Container | Untrusted | Sandboxed, only /project mount |
| Proxies | Semi-trusted | Bridge between sandbox and internet |
| DNS Filter | Semi-trusted | Controls network access |
| Internet | Untrusted | Allowlisted domains only |

## Build Tools & Development Environment

The agent container includes a comprehensive development environment for working with multiple languages and frameworks.

### Installed Tools

| Category | Tools | Version |
|----------|-------|---------|
| **Languages** | Node.js, Python 3, Go | Latest from Debian repos |
| **Package Managers** | npm, pip, uv, go mod | Latest |
| **Build Tools** | make, gcc, g++, git | Latest |
| **Utilities** | curl, jq, zip, unzip, file, gh CLI | Latest |
| **Code Quality** | pre-commit, black, ruff, detect-secrets | Latest via uv |

### Network Access for Package Managers

The sandbox provides allowlisted network access to these package repositories:

| Domain | Purpose | Proxy IP |
|--------|---------|----------|
| `api.github.com` | GitHub API (issues, PRs, releases) | 10.100.1.10 |
| `raw.githubusercontent.com` | Raw file content | 10.100.1.11 |
| `codeload.github.com` | Repository archives | 10.100.1.12 |
| `api.anthropic.com` | Claude API | 10.100.1.14 |
| `proxy.golang.org` | Go module proxy | 10.100.1.20 |
| `sum.golang.org` | Go checksum database | 10.100.1.21 |
| `pypi.org` | Python package index | 10.100.1.22 |
| `files.pythonhosted.org` | Python package files | 10.100.1.23 |

### Usage Examples

**Go Projects:**
```bash
# Inside the container
cd /project/your-go-service
go mod download
go build
go test ./...
```

**Python Projects:**
```bash
# Using venv (recommended due to PEP 668)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest

# Using uv (faster)
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

**Node.js Projects:**
```bash
npm install
npm test
npm run build
```

**Pre-commit Hooks:**
```bash
# Install and run pre-commit hooks
pre-commit install
pre-commit run --all-files
```

## Prerequisites

### macOS Apple Silicon Setup

1. **Install Docker Desktop**
   ```bash
   # Download from: https://www.docker.com/products/docker-desktop/
   # Or via Homebrew:
   brew install --cask docker
   ```

2. **Enable Enhanced Container Isolation** (Recommended)
   - Open Docker Desktop → Settings → General
   - Enable "Use containerd for pulling and storing images"
   - Under Settings → Resources → Advanced, enable "VirtioFS" for best performance
   - Under Settings → Features in Development, consider enabling "Enhanced Container Isolation" if available (Business/Team plans)

3. **Alternative: Podman**
   ```bash
   brew install podman
   podman machine init --cpus 4 --memory 4096
   podman machine start
   # Note: Compose commands use podman-compose
   ```

### Filesystem Sharing Notes

Docker Desktop on macOS uses VirtioFS or gRPC FUSE for file sharing:
- **VirtioFS** (default): Best performance, recommended
- **gRPC FUSE**: Legacy option, slower but more compatible

If you experience file sync issues, try adding your project directory to Docker Desktop → Settings → Resources → File Sharing.

## Quick Start

```bash
# 1. Clone this repository
git clone https://github.com/SapphireBeehiveStudios/sapphire-bee.git
cd sapphire-bee

# 2. Set up authentication (choose one method)
cp .env.example .env

# Option A: Claude Max subscription (recommended - included with subscription)
claude setup-token
# Then add token to .env: CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...

# Option B: API key (pay-per-use)
# Edit .env and add your ANTHROPIC_API_KEY

# 3. Run health check
make doctor

# 4. Get the agent image (recommended: use pre-built)
docker pull ghcr.io/sapphirebeehivestudios/sapphire-bee:latest
docker tag ghcr.io/sapphirebeehivestudios/sapphire-bee:latest sapphire-bee:latest

# 4a. Alternative: Build locally (only if modifying the Dockerfile)
# make build

# 5. Start persistent agent (recommended)
make up-agent PROJECT=/path/to/your/project

# 6. Run Claude commands
make claude                        # Interactive session
make claude P="your prompt here"   # Single prompt
make claude-print P="prompt"       # Non-interactive batch mode

# 7. When done
make down-agent
```

### Quick Start (One-shot Mode)

For ephemeral sessions that don't persist:

```bash
make up                                           # Start infrastructure
make run-direct PROJECT=/path/to/your/project     # One-shot session
```

## Authentication

Claude Code supports two authentication methods. Choose the one that works best for you:

### Option 1: Claude Max Subscription (Recommended)

If you have a Claude Max subscription, generate an OAuth token:

```bash
# Generate a long-lived OAuth token (valid for 1 year)
claude setup-token

# Add the token to your .env file
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...' >> .env

# Verify it's configured
./scripts/setup-claude-auth.sh status
```

### Option 2: API Key (Pay-per-use)

Get an API key from [Anthropic Console](https://console.anthropic.com/) and add it to your `.env` file:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
```

### Checking Authentication Status

```bash
./scripts/setup-claude-auth.sh status
```

This shows which authentication method is configured and ready to use.

**Note**: If both are set, `ANTHROPIC_API_KEY` takes priority over `CLAUDE_CODE_OAUTH_TOKEN`.

### Option 3: GitHub Access (Choose One)

To enable Claude to clone, commit, push, and manage issues/PRs:

#### Option A: GitHub App (Recommended)

GitHub Apps provide **short-lived tokens** (1 hour) with fine-grained permissions. See [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) for full setup instructions.

```bash
# Quick setup (after creating GitHub App - see docs)
echo 'GITHUB_APP_ID=123456' >> .env
echo 'GITHUB_APP_INSTALLATION_ID=12345678' >> .env
echo 'GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem' >> .env

# Test the configuration
make github-app-test
```

**Benefits:**
- Tokens auto-expire in 1 hour (no cleanup needed)
- Fine-grained per-repository access
- Audit logs show "github-app/your-app" (not your username)
- Higher API rate limits

#### Option B: Personal Access Token (Legacy)

```bash
# Create a PAT with the right permissions for your repo
make github-pat REPO=owner/repo

# Or manually at: https://github.com/settings/tokens
# Then add to .env file
echo 'GITHUB_PAT=github_pat_...' >> .env
```

**Required PAT Permissions:**

| Operation | Classic Token | Fine-grained Token |
|-----------|---------------|-------------------|
| Clone/push private repos | `repo` | Contents: Read/Write |
| Clone/push public repos | `public_repo` | Contents: Read/Write |
| Create/close issues | `repo` | Issues: Read/Write |
| Create/merge PRs | `repo` | Pull requests: Read/Write |
| Create releases | `repo` | Contents: Read/Write |
| View repo metadata | (included) | Metadata: Read (required) |

**Security Notes:**
- Use fine-grained tokens when possible (more granular, can limit to specific repos)
- PAT is stored in `.env` (gitignored, not committed)
- Set token expiration (90 days recommended)

#### Common Features (Both Options)

**Branch Protection (built-in):**
- Direct pushes to `main`/`master` branches are **blocked**
- Repos are cloned to a `claude/work-*` branch automatically
- Force pushes and remote branch deletions are disabled
- Changes must be merged via pull request (`gh pr create`)

**Usage:**
```bash
# Inside the container, git and gh are automatically configured

# Clone a repository:
/opt/scripts/clone-repo.sh owner/repo

# Or use git directly:
git clone https://github.com/owner/repo.git
git add .
git commit -m "Changes made by Claude"
git push

# GitHub CLI (gh) is also available for repo management:
gh issue list
gh issue create --title "Bug" --body "Description"
gh pr create --title "Fix bug" --body "Description"
gh pr list
gh pr merge 123
```

**MCP Integration (GitHub App only):**

When using GitHub App authentication, Claude Code automatically has access to GitHub MCP tools:
- `get_file_contents` - Read files from repos
- `search_code` - Search across repositories
- `create_issue` / `create_pull_request` - Manage issues and PRs
- `list_commits` - View commit history

### Using Make vs Scripts

The Makefile is for **you (the human)** to run on your Mac — it manages the sandbox from outside. Claude runs inside the container and doesn't use the Makefile.

```
┌─────────────────────────────────────────────────────────┐
│                    YOUR MAC (Host)                      │
│                                                         │
│   You run:  make build                                  │
│             make up                                     │
│             make run-direct PROJECT=~/my-project        │
│                        │                                │
│                        ▼                                │
│            ┌───────────────────────┐                    │
│            │   Makefile targets    │                    │
│            │   (calls scripts)     │                    │
│            └───────────────────────┘                    │
│                        │                                │
│                        ▼                                │
│            ┌───────────────────────┐                    │
│            │    Docker Desktop     │                    │
│            │  ┌─────────────────┐  │                    │
│            │  │ Agent Container │  │ ← Claude runs here │
│            │  │    (Claude)     │  │                    │
│            │  └─────────────────┘  │                    │
│            └───────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

You can use either `make` targets or scripts directly:

| Make Command | Description |
|--------------|-------------|
| `make doctor` | Check environment health |
| `make build` | Build the agent container image |
| `make up` | Start infrastructure (DNS + proxies) |
| **Persistent Mode** | |
| `make up-agent PROJECT=...` | Start persistent agent with local project |
| `make claude` | Interactive Claude session |
| `make claude P="..."` | Single prompt execution |
| `make claude-print P="..."` | Non-interactive batch mode (for scripts/CI) |
| `make claude-shell` | Open bash shell in agent |
| `make agent-status` | Check if agent is running |
| `make down-agent` | Stop persistent agent |
| **Isolated Mode** | |
| `make up-isolated REPO=...` | Start isolated agent (clones repo) |
| `make up-isolated REPO=... BRANCH=...` | Start with specific branch |
| `make down-isolated` | Stop agent and destroy workspace |
| **Pool Mode** | |
| `make pool-start REPO=... WORKERS=...` | Start worker pool |
| `make pool-status` | Show all workers status |
| `make pool-logs` | Follow all worker logs |
| `make pool-logs-worker WORKER=...` | Follow specific worker logs |
| `make pool-add-workers COUNT=...` | Add workers without interrupting pool |
| `make pool-cleanup-claims REPO=...` | Clean stale claim comments |
| `make pool-stop` | Stop all workers |
| **Queue Mode** | |
| `make queue-start PROJECT=...` | Start async queue processor |
| `make queue-add TASK="..." NAME=...` | Add task to queue |
| `make queue-status PROJECT=...` | Show queue status |
| `make queue-logs` | Follow queue processor logs |
| `make queue-stop` | Stop queue processor |
| **One-shot Mode** | |
| `make run-direct PROJECT=...` | Run Claude in direct mode |
| `make run-staging STAGING=...` | Run Claude in staging mode |
| `make run-offline PROJECT=...` | Run Claude in offline mode |
| **Observability** | |
| `make logs` | Follow all service logs |
| `make logs-dns` | Follow DNS filter logs |
| `make logs-report` | Generate network activity report |
| **Testing** | |
| `make test-security` | Run all security tests |
| `make ci` | Run CI workflow locally with `act` |

Run `make help` to see all available targets.

### Testing CI Locally

You can run the GitHub Actions CI workflow locally using [act](https://github.com/nektos/act):

```bash
# Install act
brew install act

# Run the full CI workflow
make ci

# Or run specific jobs
make ci-validate    # Lint and validate
make ci-build       # Build test
make ci-dry-run     # Preview without running
```

## Persistent Mode (Recommended)

Persistent mode keeps the agent container running, allowing you to:
- **Instant Claude access** - No container startup delay
- **Context persistence** - Claude remembers previous interactions within a session
- **Quick prompts** - Run single commands without entering interactive mode

```bash
# Start your work session
make up-agent PROJECT=~/my-project

# Throughout the day, run Claude commands instantly
make claude P="What files are in this project?"
make claude P="Add a new feature to the main module"
make claude P="Fix the bug in helper.py"

# For automation/scripts, use print mode (no interactive prompts)
make claude-print P="List all Python files"

# For longer conversations, use interactive mode
make claude

# Open a shell for manual exploration
make claude-shell

# Check agent status
make agent-status

# End of day - stop the agent
make down-agent
```

**Benefits over one-shot mode:**
- No 3-5 second container startup for each interaction
- Claude maintains conversation context across commands
- Multiple terminal windows can attach to the same session

## Isolated Mode (Autonomous Agent)

Isolated mode lets the agent clone a repository into its own isolated workspace. Perfect for:
- Autonomous agents that work independently
- Multi-agent workflows where each agent has its own workspace
- CI/CD integration where you don't want to mount host directories
- Maximum isolation from host filesystem

```bash
# Start isolated agent (clones repo on startup)
make up-isolated REPO=owner/repo

# Optionally specify a branch
make up-isolated REPO=owner/repo BRANCH=feature-branch

# Run Claude commands (same as persistent mode)
make claude                        # Interactive session
make claude P="fix issue #42"      # Single prompt

# Check agent status
make agent-status

# Stop and destroy workspace
make down-isolated
```

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  ISOLATED MODE                                              │
│                                                             │
│  1. Container starts with GITHUB_REPO env var               │
│  2. Entrypoint script clones the repo to /project           │
│  3. Creates a working branch: claude/work-YYYYMMDD-HHMMSS   │
│  4. Agent works in complete isolation                       │
│  5. Changes pushed via MCP tools or git push                │
│  6. Workspace destroyed when container stops                │
└─────────────────────────────────────────────────────────────┘
```

### Required Configuration

Isolated mode requires GitHub App authentication for cloning and pushing:

```bash
# In .env file
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem
```

See [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) for full setup.

### Isolated vs Persistent Mode

| Feature | Persistent Mode | Isolated Mode |
|---------|-----------------|---------------|
| Workspace | Mounted from host | Cloned fresh on startup |
| Files after stop | Persist on host | **Destroyed** |
| Git setup | Uses host's git config | Fresh clone, auto-configured |
| Best for | Interactive development | Autonomous agents |

## Pool Mode (Multiple Isolated Agents)

Pool mode runs multiple isolated agents in parallel, each processing GitHub issues from the same repository. Perfect for:
- Processing a backlog of issues automatically
- Running multiple agents 24/7 to handle incoming work
- Scaling up for large refactoring or feature batches

```
┌─────────────────────────────────────────────────────────────────────────┐
│  POOL MODE - Multiple Isolated Agents                                   │
│                                                                         │
│                    GitHub Repository                                    │
│                          │                                              │
│        ┌─────────────────┼─────────────────┐                            │
│        ▼                 ▼                 ▼                            │
│   ┌─────────┐       ┌─────────┐       ┌─────────┐                       │
│   │ Worker 1│       │ Worker 2│       │ Worker 3│   ...more             │
│   │ ─────── │       │ ─────── │       │ ─────── │                       │
│   │ Issue #5│       │ Issue #8│       │ Issue #9│                       │
│   │  (own   │       │  (own   │       │  (own   │                       │
│   │  clone) │       │  clone) │       │  clone) │                       │
│   └────┬────┘       └────┬────┘       └────┬────┘                       │
│        │                 │                 │                            │
│        └─────────────────┼─────────────────┘                            │
│                          ▼                                              │
│                    Pull Requests                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Quick Start

```bash
# Start a pool of 3 workers
make pool-start REPO=myorg/my-project WORKERS=3

# Check worker status
make pool-status

# Watch logs from all workers
make pool-logs

# Watch a specific worker's logs
make pool-logs-worker WORKER=worker-1

# Add more workers without interrupting existing ones
make pool-add-workers COUNT=2

# Clean up stale claim comments (if workers crashed)
make pool-cleanup-claims REPO=myorg/my-project

# Stop all workers
make pool-stop
```

### How It Works

1. **Workers start** - Each worker clones the repository into its own isolated Docker volume
2. **Issue polling** - Workers poll GitHub for issues labeled `agent-ready` (configurable)
3. **Claim & work** - Worker claims an issue by:
   - Adding an `in-progress` label
   - Posting a CLAIM comment with worker ID
   - Creating a branch (or checking out existing PR branch if issue has a failing PR)
4. **Execute work** - Worker runs Claude Code to implement the solution
5. **Open/Update PR** - Worker pushes changes and opens a new PR or updates existing one
6. **Next issue** - Worker removes `in-progress` label, adds `agent-complete`, polls for next issue

### Key Features

**Atomic Claiming:**
- Workers use GitHub's timestamp-based sorting to prevent race conditions
- Stale claims (>5 minutes old) are automatically ignored
- Claim comments prevent duplicate work

**PR Branch Fixing:**
- If an issue already has an open PR with failing CI, workers check out that branch
- Workers fix the failing tests/issues instead of creating duplicate PRs
- Updates existing PR with new commits

**Non-Disruptive Scaling:**
- Add workers to running pool without interrupting active workers
- Uses `docker run` instead of `docker compose --scale` to avoid recreation
- New workers join immediately and start claiming issues

**File-Based Logging:**
- Each worker conversation logged to `pool-logs/worker-<id>_<timestamp>.log`
- Easy to review what each worker did for debugging and auditing
- Centralized log directory shared across all workers

### Required Labels

Create these labels in your GitHub repository:

| Label | Purpose |
|-------|---------|
| `agent-ready` | Issues ready for agent processing (trigger label) |
| `in-progress` | Auto-added when an agent claims an issue |
| `agent-complete` | Auto-added when work is done and PR created |
| `agent-failed` | Auto-added if the agent encounters an error |

### Configuration

```bash
# Environment variables (in .env or exported)
GITHUB_REPO=myorg/my-project           # Repository to work on
ISSUE_LABEL=agent-ready                # Label to filter issues (default)
POLL_INTERVAL=60                       # Seconds between issue checks
WORKERS=3                              # Number of parallel workers

# Optional debugging flags
CLAUDE_DEBUG=1                         # Enable Claude Code debug output
GITHUB_DEBUG=1                         # Enable GitHub API debug output
POOL_DEBUG=1                           # Enable worker pool debug output
```

### Logging

All worker conversations are logged to the `pool-logs/` directory:

```
pool-logs/
├── worker-abc123_20250111_143022.log  # Worker abc123's conversation
├── worker-def456_20250111_143045.log  # Worker def456's conversation
└── ...
```

**Viewing logs:**
```bash
# Watch all workers
make pool-logs

# Watch specific worker
make pool-logs-worker WORKER=worker-1

# View completed logs
ls -lh pool-logs/
tail -f pool-logs/worker-abc123_*.log
```

### Example Workflow

1. **Triage issues** - Review and label issues that are ready for automation
2. **Add `agent-ready` label** - This queues the issue for processing
3. **Agents claim and work** - Workers automatically pick up and process issues
4. **Review PRs** - Agents open PRs that you review and merge
5. **Issues update** - Labels change to show progress (`in-progress` → `agent-complete`)

### Pool vs Queue Mode

| Feature | Pool Mode | Queue Mode |
|---------|-----------|------------|
| Task source | GitHub issues | Local file queue |
| Workspace | Isolated (per worker) | Shared project directory |
| Parallelism | Multiple workers | Single processor |
| Output | Pull requests | Direct file changes |
| Best for | Autonomous issue processing | Batch tasks on local project |

## Queue Mode (Async Processing)

Queue mode lets you add tasks to a directory and have Claude process them automatically in the background. Perfect for:
- Batch processing multiple tasks overnight
- Queueing work and walking away
- Integrating with scripts and automation

```bash
# Start the queue processor
make queue-start PROJECT=~/my-project

# Add tasks (multiple methods)
make queue-add TASK="Add feature X" NAME=001-feature PROJECT=~/my-project
echo "Fix bug Y" > ~/my-project/.claude/queue/002-bugfix.md

# Check status
make queue-status PROJECT=~/my-project

# View logs
make queue-logs

# View results
cat ~/my-project/.claude/results/001-feature.log

# Stop when done
make queue-stop
```

### Queue Directory Structure

```
/project/.claude/
├── queue/           # Drop task files here (*.md or *.txt)
├── processing/      # Currently being processed
├── completed/       # Successfully completed tasks
├── failed/          # Failed tasks
└── results/         # Execution logs
```

### Task File Format

Simple text or markdown:

```markdown
# Add New Feature

Create a helper module with:
- Utility functions
- Error handling
- Unit tests

Integrate it with the main module.
```

Tasks are processed in alphabetical order. Use numeric prefixes for ordering:
- `001-setup.md`
- `002-feature.md`
- `003-tests.md`

## Running Modes (One-shot)

The following modes start a new container for each session. Use these when you don't need persistence or want maximum isolation.

### Direct Mode (Fast)

Agent writes directly to your project directory:

```bash
./scripts/run-claude.sh direct /path/to/project
```

**Risks:**
- Agent can delete/overwrite project files immediately
- Agent could plant malicious scripts

**Mitigations:**
- Use git to track changes and review diffs
- Run `./scripts/scan-dangerous.sh` to detect suspicious patterns

### Staging Mode (Safer)

Agent writes to a separate staging directory:

```bash
# Create staging directory
mkdir -p ~/staging

# Run Claude in staging mode
./scripts/run-claude.sh staging ~/staging

# Review changes
./scripts/diff-review.sh ~/staging /path/to/live/project

# Promote after review
./scripts/promote.sh ~/staging /path/to/live/project
```

### Offline Mode (Maximum Isolation)

No network access at all:

```bash
./scripts/run-claude.sh offline /path/to/project
```

Use this for:
- Reviewing suspicious code
- Testing without API access
- Maximum security when needed

## Security Tests

The sandbox includes comprehensive pytest-based security tests that verify all security features are properly enforced.

### Running Tests

```bash
# Install test dependencies (requires uv: brew install uv)
make install-tests

# Run all security tests
make test-security

# Run in parallel (faster)
make test-security-parallel

# Run specific test suites
make test-dns          # DNS filtering
make test-network      # Network isolation
make test-hardening    # Container security
make test-filesystem   # Mount restrictions
make test-offline      # Offline mode
```

### What's Tested

| Test Suite | Verifies |
|------------|----------|
| DNS Filtering | Allowed domains resolve to proxy IPs, blocked domains return NXDOMAIN |
| Network Restrictions | Agent isolated to sandbox_net, cannot reach internet directly |
| Container Hardening | Read-only rootfs, dropped capabilities, non-root user, resource limits |
| Filesystem Restrictions | Only /project mounted, no sensitive host paths exposed |
| Offline Mode | Zero network access with `network_mode: none` |

### Test Structure

```
tests/
├── conftest.py                  # Docker Compose fixtures
├── test_dns_filtering.py        # DNS allowlist/blocklist
├── test_network_restrictions.py # Network isolation
├── test_container_hardening.py  # Security hardening
├── test_filesystem_restrictions.py # Mount verification
└── test_offline_mode.py         # Offline mode
```

Tests run automatically in CI on every push and pull request.

## Observability

### View Logs

```bash
# Live logs from all services
docker compose -f compose/compose.base.yml logs -f

# DNS filter logs only
docker compose -f compose/compose.base.yml logs -f dnsfilter

# Generate summary report
./scripts/logs-report.sh
./scripts/logs-report.sh --since 1h
./scripts/logs-report.sh --output report.txt
```

### What's Logged

| Component | What's Logged |
|-----------|---------------|
| dnsfilter | All DNS queries (allowed + blocked) |
| proxy_* | Connection attempts, bytes transferred, timing |
| agent | Session logs in `./logs/` directory |
| worker pool | Worker conversations in `./pool-logs/` directory |

## Threat Model

### What This Protects Against

1. **Arbitrary network access**: Agent can only reach allowlisted domains via proxies
2. **Host filesystem access**: Agent can only access `/project` mount
3. **Privilege escalation**: Non-root user, dropped capabilities, no-new-privileges
4. **Persistence**: Read-only rootfs, tmpfs for writable areas
5. **Resource exhaustion**: Memory/CPU limits, PID limits

### Claude Code Permissions

Claude Code has its own permission system that normally requires user approval for file edits, command execution, etc. Since security in this sandbox is enforced by **container isolation** (network allowlisting, filesystem restrictions, dropped capabilities), Claude is pre-configured with all permissions granted.

This is configured in `image/config/claude-settings.json` and applied automatically on container start via the entrypoint script. The granted permissions include:

- **Bash(*)**: Execute any shell command
- **Read(*), Write(*), Edit(*)**: Full file access within `/project`
- **WebFetch(*)**: Network requests (constrained by DNS allowlist)
- **mcp__***: MCP tool integrations

This approach means Claude can work autonomously without permission prompts, while the container sandbox enforces the actual security boundary.

**Note:** In non-interactive mode (scripts, CI/CD, queue processing), Claude Code CLI's Write/Edit tools request permission even with `bypassPermissionsMode: true` configured. Since there's no interactive terminal to grant permission, these tools are effectively unavailable. Claude automatically uses the Bash tool for file operations in these contexts, which works reliably. Impact: Low - all file operations continue to function via Bash commands.

### What This Does NOT Protect Against

1. **Malicious code in project**: If Claude writes malicious code, you could execute it
2. **Container/VM escapes**: Theoretical exploits in Docker/containerd
3. **Social engineering**: Claude could try to convince you to bypass protections
4. **Prompt injection**: Malicious content in project files could influence Claude

### How Network Allowlisting Works

```
Agent wants to access "github.com"
    │
    ▼
DNS Query → dnsfilter (CoreDNS)
    │
    ├─ github.com? → Returns 10.100.1.10 (proxy_github IP)
    │
    └─ evil.com? → Returns NXDOMAIN (blocked)

Agent connects to 10.100.1.10:443
    │
    ▼
proxy_github receives connection
    │
    ▼
proxy_github forwards to real github.com:443
```

### Mount Strategy

| Path | Direct Mode | Staging Mode | Offline Mode |
|------|-------------|--------------|--------------|
| /project | Host project (RW) | Staging dir (RW) | Host project (RW) |
| Host secrets | NOT mounted | NOT mounted | NOT mounted |
| Docker socket | NOT mounted | NOT mounted | NOT mounted |

## Cloud Transition

### Using Pre-built Images

This repository includes GitHub Actions that automatically build and push images to GitHub Container Registry on merge to main.

```bash
# Pull the latest image (multi-arch: works on both arm64 and amd64)
docker pull ghcr.io/sapphirebeehivestudios/sapphire-bee:latest

# Or pull a specific version
docker pull ghcr.io/sapphirebeehivestudios/sapphire-bee:claude-2.0.76
```

To use the pre-built image instead of building locally, update your `.env`:

```bash
# Use pre-built image from GHCR
AGENT_IMAGE=ghcr.io/sapphirebeehivestudios/sapphire-bee:latest
```

### GitHub Actions Setup

The repository includes two workflows:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PRs, pushes | Validates compose, lints scripts, test builds, security tests |
| `build-and-push.yml` | Merge to main | Builds multi-arch image, pushes to GHCR |

#### Required Setup

Set these in your repository settings:

**Secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Required | Description |
|--------|----------|-------------|
| `GITHUB_TOKEN` | Auto | Provided by GitHub, used for GHCR |
| `DOCKERHUB_USERNAME` | Optional | For also pushing to Docker Hub |
| `DOCKERHUB_TOKEN` | Optional | Docker Hub access token |

**Environment** (Settings → Environments):

Create a `production` environment for the build-and-push workflow. Optionally add required reviewers for deployment approval gates.

#### Manual Build Trigger

You can manually trigger a build:

1. Go to Actions → "Build and Push Docker Image"
2. Click "Run workflow"
3. Run

### Running in CI/CD

Use the pre-built image in your own workflows:

```yaml
# GitHub Actions example
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Claude in sandbox
        run: |
          docker run --rm \
            -v ${{ github.workspace }}:/project \
            ghcr.io/sapphirebeehivestudios/sapphire-bee:latest \
            claude --version
```

Or build locally in CI:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build agent
        run: docker build -t sapphire-bee:latest ./image
      - name: Run Claude
        run: |
          docker run --rm \
            -v ${{ github.workspace }}:/project \
            sapphire-bee:latest \
            claude --version
```

### Multi-Architecture Builds

The GitHub Action builds for both architectures automatically:

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflow                      │
│                 platforms: linux/amd64,linux/arm64              │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
   ┌─────────────────┐                 ┌─────────────────┐
   │  linux/amd64    │                 │  linux/arm64    │
   │  (x86_64)       │                 │  (Apple Silicon)│
   └─────────────────┘                 └─────────────────┘
```

For manual multi-arch builds:

```bash
# Set up buildx
docker buildx create --name multiarch --use

# Build for multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t sapphire-bee:latest \
  --push \
  ./image
```

### Git-Based Handoff

Recommended workflow for hybrid local/cloud development:

1. Claude modifies files locally
2. Human reviews with `git diff`
3. Human commits approved changes
4. CI/CD runs automated checks
5. Deploy if checks pass

## Troubleshooting

### Common Issues

**"Docker daemon is not running"**
```bash
open -a Docker  # macOS
# Wait for Docker Desktop to start
```

**DNS resolution failing**
```bash
# Check if dnsfilter is healthy
docker compose -f compose/compose.base.yml ps

# Restart services
./scripts/down.sh
./scripts/up.sh
```

**"Permission denied" on scripts**
```bash
chmod +x scripts/*.sh
```

### Performance Issues

1. **Slow file sync**: Enable VirtioFS in Docker Desktop settings
2. **High memory usage**: Adjust `AGENT_MEMORY_LIMIT` in `.env`

## Development

### Project Structure

```
sapphire-bee/
├── .github/
│   └── workflows/
│       ├── build-and-push.yml  # Build + push on merge to main
│       └── ci.yml              # Validate + test on PRs
├── compose/
│   ├── compose.base.yml      # Networks + DNS + proxies
│   ├── compose.direct.yml    # Direct mount agent (one-shot)
│   ├── compose.persistent.yml # Persistent agent container
│   ├── compose.isolated.yml  # Isolated agent (clones repo)
│   ├── compose.pool.yml      # Worker pool (multiple isolated agents)
│   ├── compose.queue.yml     # Queue processor daemon
│   ├── compose.staging.yml   # Staging mount agent
│   └── compose.offline.yml   # Offline mode
├── configs/
│   ├── coredns/
│   │   ├── Corefile          # DNS filtering rules
│   │   └── hosts.allowlist   # Allowed domains → proxy IPs
│   └── nginx/
│       └── proxy_*.conf      # TCP proxy configs
├── image/
│   ├── Dockerfile            # Agent container image
│   ├── config/
│   │   └── claude-settings.json  # Claude Code permissions (all granted)
│   ├── install/
│   │   └── install_claude_code.sh
│   └── scripts/
│       ├── entrypoint.sh     # Container entrypoint (sets up Claude config)
│       ├── issue-worker.js   # Pool worker (GitHub issue processing)
│       └── queue-watcher.js  # Async task queue processor
├── scripts/
│   ├── run-claude.sh         # Main entry point
│   ├── promote.sh            # Staging → live promotion
│   ├── diff-review.sh        # Change report generator
│   ├── scan-dangerous.sh     # Security pattern scanner
│   ├── logs-report.sh        # Log analyzer
│   ├── doctor.sh             # Environment health check
│   ├── up.sh / down.sh       # Service lifecycle
│   ├── build.sh              # Image builder
│   ├── pool-add-workers.sh   # Add workers to running pool
│   └── pool-cleanup-claims.sh # Clean stale claim comments
├── tests/                     # Security test suite
│   ├── conftest.py           # Docker Compose fixtures
│   ├── test_dns_filtering.py
│   ├── test_network_restrictions.py
│   ├── test_container_hardening.py
│   ├── test_filesystem_restrictions.py
│   └── test_offline_mode.py
├── logs/                      # Session logs (gitignored)
├── pool-logs/                 # Worker pool conversation logs (gitignored)
├── Makefile                  # Convenient make targets
├── .env.example              # Environment template
├── README.md
└── SECURITY.md
```

## Documentation

- **[Workflow Guide](docs/WORKFLOW_GUIDE.md)** - Detailed guide for Persistent and Queue modes
- **[GitHub App Setup](docs/GITHUB_APP_SETUP.md)** - Configure GitHub App for secure repo access
- **[GitHub App MCP Integration](docs/GITHUB_APP_MCP_INTEGRATION.md)** - Technical implementation details
- **[Logging Guide](docs/LOGS.md)** - Where logs are stored and how to access them
- **[CLAUDE.md](CLAUDE.md)** - Context file for Claude instances
- **[SECURITY.md](SECURITY.md)** - Threat model and security considerations
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Contribution guidelines

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
