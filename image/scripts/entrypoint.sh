#!/bin/bash
# entrypoint.sh - Container entrypoint that sets up Claude configuration
#
# This script runs on every container start to:
# 1. Set up Claude Code settings (permissions, etc.)
# 2. Configure GitHub authentication (App or PAT)
# 3. Clone repository if GITHUB_REPO is set (isolated mode)
# 4. Verify MCP configuration
# 5. Execute the provided command or default to bash
#
# The home directory is a tmpfs mount, so configuration must be
# recreated on each container start.

set -euo pipefail

# Claude settings directory
CLAUDE_CONFIG_DIR="${HOME}/.claude"
SETTINGS_FILE="${CLAUDE_CONFIG_DIR}/settings.json"

# Set up Claude Code configuration
setup_claude_config() {
    # Create Claude config directory
    mkdir -p "${CLAUDE_CONFIG_DIR}"
    
    # Copy pre-configured settings if they exist
    if [[ -f /etc/claude/settings.json ]]; then
        cp /etc/claude/settings.json "${SETTINGS_FILE}"
        
        # Verify settings file was copied successfully
        if [[ ! -f "${SETTINGS_FILE}" ]]; then
            echo "ERROR: Failed to copy settings file to ${SETTINGS_FILE}" >&2
            exit 1
        fi
        
        # Verify settings file is valid JSON (if jq is available)
        if command -v jq >/dev/null 2>&1; then
            if ! jq empty "${SETTINGS_FILE}" 2>/dev/null; then
                echo "WARNING: Settings file may not be valid JSON" >&2
            fi
        fi
    else
        echo "WARNING: /etc/claude/settings.json not found, Claude permissions may not be configured" >&2
    fi
    
    # Copy sandbox context to home directory as CLAUDE.md
    # This provides sandbox context without conflicting with project CLAUDE.md
    if [[ -f /etc/claude/sandbox-context.md ]]; then
        cp /etc/claude/sandbox-context.md "${CLAUDE_CONFIG_DIR}/CLAUDE.md"
        if [[ "${CLAUDE_DEBUG:-}" == "1" ]]; then
            echo "DEBUG: Sandbox context copied to ${CLAUDE_CONFIG_DIR}/CLAUDE.md" >&2
        fi
    fi
    
    # Mark that we've accepted terms (prevents interactive prompt)
    touch "${CLAUDE_CONFIG_DIR}/.terms-accepted"
    
    # Debug output (only if CLAUDE_DEBUG is set)
    if [[ "${CLAUDE_DEBUG:-}" == "1" ]]; then
        echo "DEBUG: Claude settings configured" >&2
        echo "DEBUG: Settings file: ${SETTINGS_FILE}" >&2
        if [[ -f "${SETTINGS_FILE}" ]]; then
            echo "DEBUG: Settings contents:" >&2
            cat "${SETTINGS_FILE}" >&2
        fi
        echo "DEBUG: Terms accepted: ${CLAUDE_CONFIG_DIR}/.terms-accepted" >&2
    fi
}

# Run setup
setup_claude_config

# Configure GitHub authentication via GitHub App (MCP only - no PAT/gh CLI)
if [[ -n "${GITHUB_APP_ID:-}" ]] && [[ -n "${GITHUB_APP_INSTALLATION_ID:-}" ]]; then
    if [[ -f /opt/scripts/setup-github-app.sh ]]; then
        # shellcheck source=/dev/null
        source /opt/scripts/setup-github-app.sh || {
            echo "ERROR: GitHub App setup failed. MCP tools will not be available." >&2
            echo "  Check GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and private key." >&2
        }
    fi
else
    echo "⚠️  No GitHub App configured. MCP tools will not be available." >&2
    echo "   Set GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID to enable GitHub access." >&2
fi

# Verify MCP configuration
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    if [[ -f /opt/scripts/verify-mcp.sh ]]; then
        echo "" >&2
        if [[ "${GITHUB_DEBUG:-}" == "1" ]]; then
            /opt/scripts/verify-mcp.sh --verbose || {
                echo "WARNING: MCP verification failed, some GitHub features may not work" >&2
            }
        else
            /opt/scripts/verify-mcp.sh || {
                echo "WARNING: MCP verification failed, some GitHub features may not work" >&2
                echo "  Run with GITHUB_DEBUG=1 for details" >&2
            }
        fi
        echo "" >&2
    fi
fi

# ============================================
# Isolated Mode: Auto-clone repository
# ============================================
# If GITHUB_REPO is set and /project is empty, clone the repository
if [[ -n "${GITHUB_REPO:-}" ]]; then
    # Check if /project is empty (or only has lost+found from ext4 volume)
    # Count files in /project excluding lost+found
    file_count=0
    for f in /project/*; do
        [[ -e "$f" ]] || continue  # handle empty glob
        [[ "$(basename "$f")" == "lost+found" ]] && continue
        file_count=$((file_count + 1))
    done
    for f in /project/.*; do
        [[ -e "$f" ]] || continue
        [[ "$(basename "$f")" == "." || "$(basename "$f")" == ".." ]] && continue
        file_count=$((file_count + 1))
    done
    
    if [[ $file_count -eq 0 ]]; then
        echo "🔄 Isolated mode: Cloning repository ${GITHUB_REPO}..." >&2
        
        BRANCH="${GITHUB_BRANCH:-main}"
        REPO_URL="https://github.com/${GITHUB_REPO}.git"
        
        # Clone the repository
        if git clone --branch "${BRANCH}" "${REPO_URL}" /project 2>&1; then
            echo "✅ Repository cloned successfully" >&2
            echo "   📁 Location: /project" >&2
            echo "   🌿 Branch: ${BRANCH}" >&2
            
            # Create a working branch for the agent
            cd /project
            WORK_BRANCH="claude/work-$(date +%Y%m%d-%H%M%S)"
            git checkout -b "${WORK_BRANCH}"
            echo "   🔀 Working branch: ${WORK_BRANCH}" >&2

            # Install pre-commit hooks if .pre-commit-config.yaml exists
            if [[ -f "/project/.pre-commit-config.yaml" ]]; then
                echo "   📦 Installing pre-commit hooks..." >&2
                if pre-commit install --install-hooks 2>/dev/null; then
                    echo "   ✅ Pre-commit hooks installed" >&2
                else
                    echo "   ⚠️  Failed to install pre-commit hooks" >&2
                fi
            fi

            # Install pre-push hook to protect main/master
            mkdir -p /project/.git/hooks
            cat > /project/.git/hooks/pre-push << 'HOOK'
#!/bin/bash
protected_branches=("main" "master")
current_branch=$(git symbolic-ref HEAD 2>/dev/null | sed 's|refs/heads/||')
for branch in "${protected_branches[@]}"; do
    if [[ "$current_branch" == "$branch" ]]; then
        echo "🛑 ERROR: Direct push to '$branch' is blocked!"
        echo "   Use MCP create_pull_request tool instead."
        exit 1
    fi
done
exit 0
HOOK
            chmod +x /project/.git/hooks/pre-push
            echo "" >&2
        else
            echo "❌ Failed to clone repository: ${GITHUB_REPO}" >&2
            echo "   Check GITHUB_REPO format (owner/repo) and authentication" >&2
        fi
    else
        echo "📂 /project is not empty, skipping clone" >&2
        echo "   (Set to existing repo or use fresh volume for auto-clone)" >&2
    fi
fi

# Execute the provided command or default to bash
exec "$@"

