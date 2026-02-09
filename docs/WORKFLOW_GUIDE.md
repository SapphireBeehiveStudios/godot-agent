# Sapphire Bee Workflow Guide

A comprehensive guide to using Claude Code with development projects in the secure sandbox.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Persistent Mode](#persistent-mode-interactive-development)
- [Queue Mode](#queue-mode-async-processing)
- [Choosing a Workflow](#choosing-a-workflow)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

Sapphire Bee provides two workflows for interacting with Claude:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   PERSISTENT MODE                      QUEUE MODE                       │
│   ───────────────                      ──────────                       │
│                                                                         │
│   ┌─────────┐                          ┌─────────┐                      │
│   │   You   │◄────────────────────────►│   You   │                      │
│   └────┬────┘  Interactive chat        └────┬────┘                      │
│        │                                    │                           │
│        │ make claude                        │ Drop files in queue/      │
│        │ make claude P="..."                │                           │
│        ▼                                    ▼                           │
│   ┌─────────┐                          ┌─────────┐                      │
│   │ Claude  │                          │ Claude  │ (daemon)             │
│   │(running)│                          │(watches)│                      │
│   └────┬────┘                          └────┬────┘                      │
│        │                                    │                           │
│        │ Immediate changes                  │ Processes async           │
│        ▼                                    ▼                           │
│   ┌─────────┐                          ┌─────────┐                      │
│   │ Project │                          │ Project │ + Results in         │
│   │  Files  │                          │  Files  │   .claude/results/   │
│   └─────────┘                          └─────────┘                      │
│                                                                         │
│   Best for:                            Best for:                        │
│   • Active development                 • Batch processing               │
│   • Conversations                      • Overnight tasks                │
│   • Quick questions                    • Automation/scripts             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

Before using either workflow, ensure you have:

### 1. Docker Running

```bash
# Verify Docker is running
docker ps
```

### 2. Authentication Configured

```bash
# Check auth status
make auth

# If not configured, add to .env:
# Option A: Claude Max subscription (recommended)
echo 'CLAUDE_CODE_OAUTH_TOKEN=your-token-here' >> .env

# Option B: API key (pay-per-use)
echo 'ANTHROPIC_API_KEY=your-key-here' >> .env
```

### 3. Agent Image Built

```bash
# Build the agent image
make build

# Or pull pre-built image
docker pull ghcr.io/sapphirebeehivestudios/sapphire-bee:latest
docker tag ghcr.io/sapphirebeehivestudios/sapphire-bee:latest sapphire-bee:latest
```

### 4. Environment Check

```bash
# Run the doctor to verify everything
make doctor
```

### Note: Claude Permissions

Claude Code runs with **all permissions pre-granted** inside the sandbox. This means:
- No permission prompts for file edits, command execution, etc.
- Claude can work autonomously on tasks
- Security is enforced by the container sandbox (network allowlist, filesystem restrictions, dropped capabilities), not by Claude's internal permission system

This is configured in `image/config/claude-settings.json` and applied automatically on container start.

---

## Persistent Mode (Interactive Development)

Persistent mode keeps Claude running in a container, allowing instant access for interactive work.

### Starting a Session

```bash
# Start the persistent agent with your project
make up-agent PROJECT=/path/to/your/project

# Example:
make up-agent PROJECT=~/projects/my-app
```

This:
1. Starts infrastructure (DNS filter + network proxies)
2. Starts the agent container (stays running)
3. Mounts your project at `/project` inside the container

### Running Claude Commands

#### Interactive Session

```bash
# Start an interactive Claude session (REPL-style)
make claude
```

This opens a conversation where you can chat back and forth:

```
You: What files are in this project?
Claude: I can see the following structure...

You: Add a user authentication module
Claude: I'll create src/auth/authentication.py...

You: exit
```

#### Single Prompts

```bash
# Run a single prompt and return
make claude P="List all Python files in this project"

# Complex prompts with quotes
make claude P="Create a user authentication module with login, logout, and session management"

# Multi-line prompts (use shell quoting)
make claude P="Refactor the database module to:
1. Use connection pooling
2. Add retry logic
3. Implement proper error handling"
```

#### Non-Interactive / Automation Mode

For running from scripts, CI/CD, or other automation contexts:

```bash
# Print mode - outputs result without interactive prompts
make claude-print P="Generate a list of all scene files"

# Or use the script directly
./scripts/claude-exec.sh --print "Your prompt here"
```

**TTY Auto-Detection**: The script automatically detects whether a terminal is attached and adjusts behavior:
- With TTY: Uses `-it` flags for interactive mode
- Without TTY: Runs non-interactively (safe for scripts and CI)

**Note on Non-Interactive Mode:** In non-interactive contexts (scripts, CI/CD), Claude Code CLI's Write/Edit tools request permission even with `bypassPermissionsMode: true` configured. Since there's no terminal to grant permission, these tools are effectively unavailable. Claude automatically uses the Bash tool for file operations in these cases, which works reliably. Impact: Low - file creation and modification still work correctly via Bash commands.

### Checking Status

```bash
# Check if agent is running
make agent-status

# Or use the shortcut
make a
```

### Opening a Shell

For manual exploration or debugging:

```bash
# Open bash shell in the container
make claude-shell

# Inside the container:
ls -la
python --version
cat src/main.py
```

### Stopping the Agent

```bash
# Stop the agent container
make down-agent
```

### Complete Example Session

```bash
# Morning: Start your session
make up-agent PROJECT=~/projects/my-app

# Work throughout the day
make claude P="What's the current project structure?"
make claude P="Add a REST API endpoint for user profiles"
make claude P="Create a configuration manager singleton"

# Longer conversation for complex feature
make claude
> Let's implement a caching system
> ...back and forth conversation...
> exit

# Check something in the container
make claude-shell
$ cat src/config.py
$ exit

# End of day
make down-agent
```

---

## Queue Mode (Async Processing)

Queue mode runs Claude as a background daemon that processes task files automatically.

### Starting the Queue Processor

```bash
# Start the queue processor
make queue-start PROJECT=/path/to/your/project

# Example:
make queue-start PROJECT=~/projects/my-app
```

This:
1. Creates queue directories in your project (`.claude/queue/`, etc.)
2. Starts the queue watcher daemon
3. Begins monitoring for task files

### Adding Tasks

#### Using make queue-add

```bash
# Add a task with a name
make queue-add TASK="Add user authentication" NAME=001-auth PROJECT=~/projects/my-app

# Add another task
make queue-add TASK="Add API rate limiting middleware" NAME=002-ratelimit PROJECT=~/projects/my-app
```

#### Dropping Files Directly

Create `.md` or `.txt` files in the queue directory:

```bash
# Simple one-liner
echo "Add input validation to all forms" > ~/projects/my-app/.claude/queue/003-validation.md

# More detailed task file
cat > ~/projects/my-app/.claude/queue/004-caching.md << 'EOF'
# Implement Caching System

## Requirements
- Create a Cache class with TTL support
- Support multiple backends (memory, Redis)
- Cache decorator for functions
- Automatic cache invalidation

## Files to create
- src/cache/cache.py
- src/cache/backends.py
- src/cache/decorators.py

## Notes
- Use dependency injection for backend selection
- Cache should be configurable via environment
EOF
```

### Task File Naming

Tasks are processed in **alphabetical order**. Use numeric prefixes to control order:

```
.claude/queue/
├── 001-setup-project.md      # Processed first
├── 002-add-player.md         # Processed second
├── 003-add-enemies.md        # Processed third
└── 010-polish-effects.md     # Processed later
```

### Monitoring Progress

#### Check Queue Status

```bash
make queue-status PROJECT=~/projects/my-app
```

Output:
```
╔══════════════════════════════════════════════════════════════════════╗
║                         Queue Status                                 ║
╚══════════════════════════════════════════════════════════════════════╝

📬 Pending tasks:
   - 003-validation.md
   - 004-caching.md

⚙️  Processing:
   - 002-ratelimit.md

✅ Completed (last 5):
   - 001-auth.md

❌ Failed:
   (none)

🟢 Queue processor: RUNNING
```

#### Watch Logs in Real-Time

```bash
make queue-logs
```

This streams the queue processor output so you can watch Claude work.

#### View Results

```bash
# Show the latest result
make queue-results PROJECT=~/projects/my-app

# View a specific result
cat ~/projects/my-app/.claude/results/001-auth.log
```

### Queue Directory Structure

After running, your project will have:

```
your-project/
├── .claude/
│   ├── queue/           # Drop new tasks here
│   │   └── 005-next-task.md
│   ├── processing/      # Currently being worked on
│   │   └── 004-caching.md
│   ├── completed/       # Successfully finished
│   │   ├── 001-auth.md
│   │   ├── 002-ratelimit.md
│   │   └── 003-validation.md
│   ├── failed/          # Tasks that errored
│   │   └── (hopefully empty)
│   └── results/         # Execution logs
│       ├── 001-auth.log
│       ├── 002-ratelimit.log
│       └── 003-validation.log
├── src/
├── tests/
└── README.md
```

### Stopping the Queue

```bash
make queue-stop
```

### Complete Example: Overnight Batch Processing

```bash
# Evening: Set up batch processing
make queue-start PROJECT=~/projects/my-app

# Add all your tasks for overnight
make queue-add TASK="Implement user authentication with JWT" \
    NAME=001-auth PROJECT=~/projects/my-app

make queue-add TASK="Create API rate limiting middleware" \
    NAME=002-ratelimit PROJECT=~/projects/my-app

make queue-add TASK="Add input validation for all endpoints" \
    NAME=003-validation PROJECT=~/projects/my-app

make queue-add TASK="Create admin dashboard API endpoints" \
    NAME=004-admin PROJECT=~/projects/my-app

make queue-add TASK="Add comprehensive test coverage" \
    NAME=005-tests PROJECT=~/projects/my-app

# Check they're queued
make queue-status PROJECT=~/projects/my-app

# Go to sleep

# Morning: Check results
make queue-status PROJECT=~/projects/my-app
cat ~/projects/my-app/.claude/results/001-auth.log

# Stop the queue
make queue-stop

# Review changes in git
cd ~/projects/my-app
git status
git diff
```

---

## Choosing a Workflow

| Scenario | Recommended | Why |
|----------|-------------|-----|
| Active coding session | **Persistent** | Interactive feedback, conversation context |
| Quick question | **Persistent** | Instant response |
| Multiple known tasks | **Queue** | Set and forget |
| Overnight processing | **Queue** | Runs while you sleep |
| Exploring/learning | **Persistent** | Back-and-forth dialogue |
| Batch refactoring | **Queue** | Process many files systematically |
| Debugging an issue | **Persistent** | Iterative investigation |
| Feature implementation | **Persistent** | Complex, needs guidance |
| Code generation tasks | **Queue** | Well-defined, independent |
| CI/CD integration | **Persistent + Print** | Use `make claude-print` for scripted execution |
| Shell script automation | **Persistent + Print** | Non-interactive, TTY auto-detection |

### Can I Use Both?

**Not simultaneously** - both use the same `agent` container name. But you can:

1. Use Persistent mode during work hours
2. Switch to Queue mode for overnight batch processing

```bash
# Switch from Persistent to Queue
make down-agent
make queue-start PROJECT=~/projects/my-app

# Switch from Queue to Persistent
make queue-stop
make up-agent PROJECT=~/projects/my-app
```

---

## Best Practices

### 1. Use Git for Safety

Always track your project with git so you can review/revert Claude's changes:

```bash
cd ~/projects/my-app

# Before starting a session
git status  # Make sure working tree is clean
git checkout -b feature/claude-additions

# After Claude makes changes
git diff
git add -p  # Selectively stage changes
git commit -m "feat: add authentication module (Claude-assisted)"
```

### 2. Write Clear Task Descriptions

Bad:
```
Add stuff to the app
```

Good:
```
Create a user authentication module (src/auth/auth.py) with:
- JWT-based authentication
- Login endpoint with email/password
- Token refresh mechanism
- Password hashing with bcrypt
- Session management with Redis
```

### 3. Review Before Running Generated Code

Claude can write plausible-looking code that has bugs. Before running:

1. Review the generated code
2. Check for obvious issues
3. Run the security scanner: `make scan PROJECT=~/projects/my-app`

### 4. Use Staging Mode for Untrusted Tasks

If you're not sure about a task, use staging mode to isolate changes:

```bash
# Create staging area
mkdir -p ~/staging
cp -r ~/projects/my-app/* ~/staging/

# Run in staging mode
make run-staging STAGING=~/staging

# Review changes
make diff-review STAGING=~/staging LIVE=~/projects/my-app

# If satisfied, promote
make promote STAGING=~/staging LIVE=~/projects/my-app
```

### 5. Break Down Complex Tasks

Instead of:
```
Build the entire application
```

Break it into:
```
001-project-setup.md     - Set up project structure and folders
002-database.md          - Create database models and migrations
003-api-auth.md          - Add authentication endpoints
004-api-core.md          - Create core API endpoints
005-tests.md             - Add comprehensive test coverage
```

### 6. Include Context in Queue Tasks

Queue tasks run independently without conversation context. Include relevant info:

```markdown
# Add Rate Limiting

## Current Project Context
- Using Python 3.11 with FastAPI
- Database is PostgreSQL with SQLAlchemy ORM
- Authentication uses JWT tokens
- Redis is available for caching

## Task
Create rate limiting middleware that limits requests per user...
```

---

## Troubleshooting

### Agent Won't Start

```bash
# Check Docker is running
docker ps

# Check for port conflicts or existing containers
docker ps -a | grep agent
docker rm -f agent  # Remove if stuck

# Restart everything
make down
make up-agent PROJECT=~/projects/my-app
```

### Claude Not Responding

```bash
# Check authentication
make auth

# Check agent is running
make agent-status

# Check logs for errors
docker logs agent
```

### Queue Not Processing

```bash
# Check queue processor is running
make queue-status PROJECT=~/projects/my-app

# Check logs for errors
make queue-logs

# Restart queue
make queue-stop
make queue-start PROJECT=~/projects/my-app
```

### Permission Issues

```bash
# If .claude directories have wrong permissions
sudo chown -R $(whoami) ~/projects/my-app/.claude
```

### Container Exits Immediately

```bash
# Check container logs
docker logs agent

# Common causes:
# - Missing auth credentials
# - Invalid project path
# - Docker resource limits
```

### Network Issues (Claude can't reach API)

```bash
# Check infrastructure is running
make status

# Check DNS filter logs
make logs-dns

# Restart infrastructure
make restart
```

---

## Quick Reference

### Persistent Mode Commands

| Command | Description |
|---------|-------------|
| `make up-agent PROJECT=...` | Start persistent agent |
| `make claude` | Interactive session |
| `make claude P="..."` | Single prompt |
| `make claude-print P="..."` | Non-interactive batch mode |
| `make agent-status` | Check if running |
| `make claude-shell` | Open bash shell |
| `make down-agent` | Stop agent |

### Queue Mode Commands

| Command | Description |
|---------|-------------|
| `make queue-start PROJECT=...` | Start queue processor |
| `make queue-add TASK="..." NAME=...` | Add task |
| `make queue-status PROJECT=...` | Show queue status |
| `make queue-logs` | Follow processor logs |
| `make queue-results PROJECT=...` | Show latest result |
| `make queue-stop` | Stop processor |

### Shortcuts

| Short | Full |
|-------|------|
| `make c` | `make claude` |
| `make cp` | `make claude-print` |
| `make a` | `make agent-status` |
| `make q` | `make queue-status` |
| `make qs` | `make queue-start` |
| `make qx` | `make queue-stop` |

---

## Getting Help

- **Project README**: General setup and architecture
- **CLAUDE.md**: Context for Claude instances
- **SECURITY.md**: Threat model and security considerations
- **GitHub Issues**: Report bugs or request features

Happy coding!

