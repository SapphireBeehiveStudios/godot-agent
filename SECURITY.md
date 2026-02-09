# Security Guide

This document describes the security model, configuration requirements, and best practices for the Sapphire Bee Sandbox.

## Security Model Overview

The sandbox follows a defense-in-depth approach:

1. **Container Isolation**: Agent runs in a hardened container
2. **Network Allowlisting**: Only specific domains are accessible
3. **Filesystem Restrictions**: Limited to project directory
4. **Capability Dropping**: Minimal Linux capabilities
5. **Resource Limits**: Prevent DoS attacks

## Critical Don'ts ⛔

### NEVER mount these directories:

```yaml
# DANGEROUS - Exposes all your files
volumes:
  - $HOME:/home  # ❌ NEVER

# DANGEROUS - Exposes SSH keys and credentials  
volumes:
  - ~/.ssh:/root/.ssh  # ❌ NEVER
  - ~/.aws:/root/.aws  # ❌ NEVER
  - ~/.config:/root/.config  # ❌ NEVER

# DANGEROUS - Container escape vector
volumes:
  - /var/run/docker.sock:/var/run/docker.sock  # ❌ NEVER
```

### NEVER run with these flags:

```yaml
# DANGEROUS - Full host access
privileged: true  # ❌ NEVER

# DANGEROUS - All capabilities
cap_add:
  - ALL  # ❌ NEVER

# DANGEROUS - Root access
user: root  # ❌ NEVER

# DANGEROUS - Host networking
network_mode: host  # ❌ NEVER
```

### NEVER add broad network allowlists:

```
# DANGEROUS - In hosts.allowlist
*  # ❌ NEVER - allows all domains
*.com  # ❌ NEVER - too broad
*.amazonaws.com  # ❌ NEVER - includes S3, secrets
```

## Authentication Security

The sandbox supports two authentication methods. Choose the one appropriate for your use case.

### Claude Max OAuth Token (Recommended)

Using a Claude Max OAuth token is recommended because:
- Usage included with subscription (no surprise charges)
- Token is long-lived (1 year) but can be revoked
- Passed as environment variable (not stored in container)

**Setup**:
```bash
claude setup-token
# Add the token to .env: CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...
```

**If your OAuth token is compromised**:
1. Generate a new token with `claude setup-token`
2. Update your `.env` file with the new token
3. The old token should be automatically invalidated

### API Key Authentication

If using an API key (pay-per-use):

**If Your Anthropic API Key is Exposed**:

1. **Immediately revoke the key**:
   - Go to https://console.anthropic.com/
   - Navigate to API Keys
   - Delete the compromised key
   - Generate a new key

2. **Review API usage**:
   - Check for unauthorized API calls
   - Review billing for unexpected charges

3. **Update your environment**:
   ```bash
   # Remove old .env
   rm .env
   
   # Create new one with new key
   cp .env.example .env
   # Edit with new ANTHROPIC_API_KEY
   ```

4. **Rotate any related credentials**:
   - If the key was committed to git, consider other secrets in that repo compromised
   - Rotate any tokens/passwords that might have been in the same files

### Best Practices

1. **Install pre-commit hooks**: `make install-hooks` (scans for secrets before commit)
2. **Prefer Claude Max** over API keys when possible
3. **Use `.env` files** (gitignored) for API keys
4. **Never commit secrets** to version control
5. **Set up spending limits** in Anthropic console if using API keys
6. **Monitor usage** for anomalies
7. **Run `./scripts/setup-claude-auth.sh status`** to verify your configuration

## Reviewing Suspicious Code

### Dangerous Pattern Scan

Run the automated scanner:

```bash
./scripts/scan-dangerous.sh /path/to/project
```

### Manual Review Patterns

Look for these high-risk patterns in your code:

**Shell/Bash:**
```bash
# Command injection vectors
eval "$user_input"           # Dynamic code execution
bash -c "$cmd"               # Shell command execution
curl ... | bash              # Remote code execution
```

**Python:**
```python
# Code execution
exec(...)                    # Dynamic code execution
eval(...)                    # Expression evaluation
subprocess.run(..., shell=True)  # Shell injection risk
os.system(...)               # Command execution
```

**JavaScript/Node:**
```javascript
// Code execution
eval(...)                    // Dynamic code execution
new Function(...)            // Dynamic function creation
child_process.exec(...)      // Shell command execution
```

### Grep Commands for Manual Review

```bash
# Find eval/exec patterns
grep -rn "eval\|exec" --include="*.py" --include="*.js" /path/to/project

# Find subprocess calls
grep -rn "subprocess\|os\.system" --include="*.py" /path/to/project

# Find child_process usage
grep -rn "child_process\|spawn\|exec" --include="*.js" /path/to/project

# Find shell script execution
grep -rn "bash -c\|sh -c" /path/to/project
```

### Before Running Generated Code

1. **Stop Claude session** first
2. **Review git diff** of all changes
3. **Run the security scan**
4. **Don't run unknown scripts** without review

## Claude Code Permissions

Claude Code has its own internal permission system that normally requires user approval for file operations, command execution, etc. In this sandbox, **all Claude Code permissions are pre-granted**.

### Why?

Security is enforced at the **container level**, not by Claude's internal permission system:

| Layer | Enforcement |
|-------|-------------|
| Network access | DNS allowlist + proxy architecture |
| Filesystem access | Container volume mounts (only `/project`) |
| Privilege escalation | Dropped capabilities, no-new-privileges |
| Resource usage | Memory/CPU/PID limits |

Claude's internal permissions would be redundant and would prevent autonomous operation in non-interactive modes (queue processing, single prompts).

### Configuration

The permissions are defined in `image/config/claude-settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "WebFetch(*)",
      "mcp__*"
    ]
  }
}
```

This file is copied to `~/.claude/settings.json` on container start via `image/scripts/entrypoint.sh`.

### Security Implication

- Claude can execute any command without prompts
- All file operations are allowed (within `/project`)
- Network requests work (constrained by DNS allowlist)
- **This is safe because the container sandbox enforces the real boundaries**

If you need stricter control, use the container-level restrictions (e.g., offline mode, staging mode) rather than relying on Claude's internal permissions.

### Non-Interactive Mode Behavior

When Claude Code CLI runs in non-interactive mode (no TTY attached, such as in scripts, CI/CD, or queue processing), the Write/Edit tools request permission even when `bypassPermissionsMode: true` is configured. Since there's no interactive terminal to grant permission, these tools are effectively unavailable in non-interactive contexts. This is a built-in Claude Code CLI safety behavior.

**Workaround:** Claude automatically uses the Bash tool for file operations in non-interactive contexts. The Bash tool works reliably in both interactive and non-interactive modes, so file creation and modification still function correctly (e.g., using `echo`, `cat`, or heredoc syntax).

**Impact:** Low - Claude Code is fully functional for code analysis, file reading, and can perform all file operations via Bash commands.

## Container Hardening Details

### Applied Security Measures

```yaml
# From compose files
security_opt:
  - no-new-privileges:true  # Prevents privilege escalation

cap_drop:
  - ALL  # Remove all capabilities

read_only: true  # Immutable root filesystem

tmpfs:
  - /tmp:size=100M  # Limited writable space

pids_limit: 256  # Prevent fork bombs

deploy:
  resources:
    limits:
      memory: 2G  # Prevent memory exhaustion
      cpus: "2.0"  # Limit CPU usage
```

### User Isolation

```dockerfile
# Agent runs as non-root user 'claude' (uid 1000)
USER claude
```

This means:
- No access to privileged operations
- Cannot modify system files
- Cannot bind to ports < 1024

## Network Security

### DNS Filtering

The CoreDNS filter:
- **Allows**: Specific domains (GitHub, Anthropic API)
- **Blocks**: Everything else (returns NXDOMAIN)
- **Logs**: All queries (for audit)

### Proxy Architecture

```
Agent → Can only reach → sandbox_net (internal)
                              ↓
                         Proxy containers
                              ↓
                        egress_net (internet)
                              ↓
                    Specific upstream hosts only
```

### Adding New Allowed Domains

If you need to allow additional domains:

1. **Evaluate the risk**: Does this domain need to be accessible?
2. **Edit** `configs/coredns/hosts.allowlist`:
   ```
   10.100.1.XX newdomain.com
   ```
3. **Create a new proxy** in `compose/compose.base.yml`
4. **Create nginx config** in `configs/nginx/proxy_newdomain.conf`
5. **Restart services**:
   ```bash
   ./scripts/down.sh && ./scripts/up.sh
   ```

## Failure Modes and Mitigations

### Misconfiguration Risks

| Risk | Impact | Prevention |
|------|--------|------------|
| Mounting $HOME | Full secrets exposure | Never modify volume mounts without review |
| Privileged mode | Container escape | Never add privileged: true |
| Docker socket mount | Full host control | Socket is not mounted by design |
| Broad DNS allowlist | Unrestricted network | Only add specific domains |

### Container/VM Escape

**Risk**: Theoretical exploits in containerd, runc, or hypervisor

**Mitigations**:
- Keep Docker Desktop updated
- Use "Enhanced Container Isolation" if available
- Monitor Docker security advisories
- Consider running in a dedicated VM for high-risk operations

### Prompt Injection

**Risk**: Malicious content in project files could influence Claude's behavior

**Mitigations**:
- Review unfamiliar files before adding to project
- Be skeptical of Claude suggestions that disable security measures
- Don't run `--privileged` even if Claude suggests it

### Social Engineering

**Risk**: Claude might suggest bypassing security measures

**Examples of suspicious suggestions**:
- "Let me access the Docker socket to help with containers"
- "Mount your home directory so I can find configuration files"
- "Run this with sudo to fix permissions"

**Response**:
- Refuse requests to weaken security configuration
- Review the security rationale in this document
- Ask "why is this necessary?" and verify independently

## Incident Response

### If You Suspect Compromise

1. **Stop all containers immediately**:
   ```bash
   ./scripts/down.sh
   docker stop $(docker ps -q)
   ```

2. **Disconnect from network** if actively under attack

3. **Preserve evidence**:
   ```bash
   docker logs dnsfilter > dns_logs.txt
   docker logs proxy_github > proxy_logs.txt
   ./scripts/logs-report.sh --output incident_report.txt
   ```

4. **Review file changes**:
   ```bash
   cd /path/to/project
   git status
   git diff
   ```

5. **Check for persistence**:
   - Review any new files in project
   - Check for modified scripts
   - Look for suspicious cron jobs or startup items

6. **Rotate credentials**:
   - API keys
   - Any secrets that might have been accessible

7. **Report** to appropriate parties if real compromise occurred

## Security Checklist

Before each Claude session:

- [ ] `.env` file is not committed to git
- [ ] Only necessary project directory is mounted
- [ ] Docker Desktop is up to date
- [ ] Previous session logs reviewed if suspicious activity
- [ ] Git repository is clean (to track changes)

After each Claude session:

- [ ] Review `git diff` for all changes
- [ ] Run `./scripts/scan-dangerous.sh`
- [ ] Check DNS logs for blocked requests
- [ ] Consider: "Would I write this code myself?"

## Contact

For security issues with this sandbox, contact: [your security contact]

For Anthropic/Claude security issues: security@anthropic.com

