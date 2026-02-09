# Pool Worker Logging Guide

This guide explains how to stream and monitor Claude Code conversations from pool workers.

## The Problem (Fixed)

Previously, when running Claude Code with `--print --dangerously-skip-permissions`, the full conversation wasn't visible - only the final result was output. This made it impossible to follow what the workers were doing in real-time.

## The Solution

We've made two key changes:

1. **Removed `--print` flag** - Now Claude streams the full conversation to stdout
2. **Added dual logging** - Conversations are now logged to both Docker stdout AND persistent files

## Logging Locations

### 1. Docker Logs (Real-time, Ephemeral)

**Best for:** Live monitoring, debugging active workers

```bash
# Follow all workers simultaneously
make pool-logs
# or shortcut:
make pl

# Follow a specific worker
make pool-logs-worker WORKER=1
make plw WORKER=1
```

**What you'll see:**
- Worker startup banners
- Issue claiming/processing messages
- **Full Claude conversations** (streaming)
- Git operations
- PR creation

### 2. Persistent Log Files (Permanent, Searchable)

**Best for:** Post-mortem analysis, archiving, search

```bash
# Follow all conversation log files in real-time
make pool-logs-files
# or shortcut:
make plf

# View logs directly
ls -lth pool-logs/
tail -f pool-logs/worker-*.log

# Search across all logs
grep -r "error" pool-logs/
grep -r "issue #42" pool-logs/
```

**Log file naming:**
```
pool-logs/worker-{WORKER_ID}-issue-{NUMBER}-{TIMESTAMP}.log
```

Example:
```
pool-logs/worker-abc123-issue-42-1704729600000.log
```

**What's in the files:**
- Full Claude conversation (questions, responses, tool calls)
- Timestamps
- Worker ID and issue details
- Exit codes

## Quick Start

### Basic Monitoring

```bash
# Terminal 1: Start the pool
make pool-start REPO=owner/repo WORKERS=3

# Terminal 2: Follow all workers in real-time
make pool-logs

# Terminal 3: Follow conversation files (persistent)
make pool-logs-files
```

### Advanced Monitoring

```bash
# Watch for errors across all workers
make pool-logs | grep -i error

# Monitor specific worker
make pool-logs-worker WORKER=2

# Search historical logs
grep -r "Failed to" pool-logs/

# Count successful completions
grep -c "Completed issue" pool-logs/*.log

# View most recent log file
tail -f pool-logs/$(ls -t pool-logs/ | head -1)
```

## Log Retention

- **Docker logs**: Cleared when containers are stopped/removed
- **File logs**: Persist in `pool-logs/` directory until manually deleted

To clean up old logs:
```bash
# Remove logs older than 7 days
find pool-logs/ -name "*.log" -mtime +7 -delete

# Remove all logs
rm -rf pool-logs/*.log
```

## Comparison: Before vs After

| Feature | Before | After |
|---------|--------|-------|
| Conversation visibility | ❌ Final result only | ✅ Full streaming conversation |
| Real-time monitoring | ⚠️ Limited | ✅ Full Docker logs + file logs |
| Persistent logs | ❌ None | ✅ Individual files per issue |
| Search/grep | ❌ Limited to docker logs | ✅ Persistent files on disk |
| Post-mortem analysis | ⚠️ Difficult | ✅ Easy - files survive restarts |

## Technical Details

### Changes Made

1. **image/scripts/issue-worker.js**:
   - Removed `--print` flag from Claude invocation
   - Added file logging to `/pool-logs` directory
   - Each conversation gets a unique log file with metadata

2. **compose/compose.pool.yml**:
   - Added `../pool-logs:/pool-logs:rw` volume mount
   - Workers can write to shared centralized log directory

3. **Makefile**:
   - Added `pool-logs-files` target for following file logs
   - Updated help text
   - Added `plf` shortcut

### Environment Variable

Changed in issue-worker.js:
```javascript
// Before
env: { ...process.env, TERM: 'dumb' }

// After
env: { ...process.env, TERM: 'xterm-256color' }
```

This provides better terminal support for Claude's output formatting.

## Troubleshooting

### No conversation output in Docker logs

If you still don't see conversations:
```bash
# Check Claude version in container
docker exec compose-worker-1 claude --version

# Test Claude directly
docker exec -it compose-worker-1 bash
claude "What is 2+2?"
```

### No log files in pool-logs/

The directory is created when workers **start processing issues**. Until then:
```bash
# Check if volume is mounted
docker exec compose-worker-1 ls -la /pool-logs

# Should show: drwxr-xr-x ... /pool-logs
```

### Log files exist but no content

Check worker stderr for errors:
```bash
make pool-logs | grep -i "failed to create log"
```

## Best Practices

1. **Always monitor new deployments** with `make pool-logs` to catch issues early
2. **Periodically clean up logs** to prevent disk space issues
3. **Use file logs for debugging** specific issues after they occur
4. **Use Docker logs for live monitoring** during active development
5. **grep is your friend** - the persistent logs are designed to be searchable

## Related Documentation

- [docs/LOGS.md](LOGS.md) - General logging guide for all modes
- [docs/WORKFLOW_GUIDE.md](WORKFLOW_GUIDE.md) - Pool mode workflows
- [CLAUDE.md](../CLAUDE.md#skill-pool-mode-multi-worker-issue-processing) - Pool mode reference
