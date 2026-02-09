#!/bin/bash
# clone-repo.sh - Clones a GitHub repository using GitHub App authentication
#
# Usage:
#   /opt/scripts/clone-repo.sh owner/repo [target-directory]
#   /opt/scripts/clone-repo.sh https://github.com/owner/repo.git [target-directory]
#
# Examples:
#   /opt/scripts/clone-repo.sh SapphireBeehiveStudios/sapphire-bee
#   /opt/scripts/clone-repo.sh myorg/myrepo /project/my-repo
#
# Requires:
#   GITHUB_TOKEN environment variable (set by GitHub App setup)

set -euo pipefail

# Parse arguments
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <owner/repo> [target-directory]" >&2
    echo "   or: $0 <full-github-url> [target-directory]" >&2
    exit 1
fi

REPO_SPEC="$1"
TARGET_DIR="${2:-}"

# Determine repository URL
if [[ "$REPO_SPEC" =~ ^https?:// ]]; then
    # Full URL provided
    REPO_URL="$REPO_SPEC"
    # Extract repo name from URL for default target directory
    if [[ -z "$TARGET_DIR" ]]; then
        REPO_NAME=$(basename "$REPO_SPEC" .git)
        TARGET_DIR="/project/${REPO_NAME}"
    fi
elif [[ "$REPO_SPEC" =~ ^[^/]+/[^/]+$ ]]; then
    # owner/repo format
    REPO_URL="https://github.com/${REPO_SPEC}.git"
    if [[ -z "$TARGET_DIR" ]]; then
        REPO_NAME=$(basename "$REPO_SPEC")
        TARGET_DIR="/project/${REPO_NAME}"
    fi
else
    echo "ERROR: Invalid repository specification: $REPO_SPEC" >&2
    echo "Expected format: owner/repo or https://github.com/owner/repo.git" >&2
    exit 1
fi

# Check if target directory already exists
if [[ -d "$TARGET_DIR" ]]; then
    echo "ERROR: Target directory already exists: $TARGET_DIR" >&2
    exit 1
fi

# Check if GITHUB_TOKEN is set (from GitHub App)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "WARNING: GITHUB_TOKEN not set. Cloning will only work for public repositories." >&2
    echo "  Ensure GitHub App is configured (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID)." >&2
fi

# Clone the repository
echo "Cloning repository: $REPO_URL"
echo "Target directory: $TARGET_DIR"

if ! git clone "$REPO_URL" "$TARGET_DIR"; then
    echo "ERROR: Failed to clone repository" >&2
    exit 1
fi

echo "Successfully cloned repository to: $TARGET_DIR"
echo ""

# ============================================
# SAFETY: Install pre-push hook to protect main/master
# ============================================
HOOKS_DIR="${TARGET_DIR}/.git/hooks"
mkdir -p "${HOOKS_DIR}"

cat > "${HOOKS_DIR}/pre-push" << 'HOOK'
#!/bin/bash
# Pre-push hook: Prevent direct pushes to main/master branches

protected_branches=("main" "master")
current_branch=$(git symbolic-ref HEAD 2>/dev/null | sed 's|refs/heads/||')

for branch in "${protected_branches[@]}"; do
    if [[ "$current_branch" == "$branch" ]]; then
        echo "🛑 ERROR: Direct push to '$branch' branch is blocked!"
        echo ""
        echo "To make changes safely:"
        echo "  1. Create a feature branch:  git checkout -b claude/my-changes"
        echo "  2. Make your changes and commit"
        echo "  3. Push the feature branch:  git push -u origin claude/my-changes"
        echo "  4. Create a PR:              Use MCP create_pull_request tool"
        echo ""
        exit 1
    fi
done

exit 0
HOOK

chmod +x "${HOOKS_DIR}/pre-push"

# Create a working branch automatically
cd "$TARGET_DIR"
BRANCH_NAME="claude/work-$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH_NAME"

# Install pre-commit hooks if .pre-commit-config.yaml exists
if [[ -f "${TARGET_DIR}/.pre-commit-config.yaml" ]]; then
    echo "📦 Installing pre-commit hooks..."
    if pre-commit install --install-hooks 2>/dev/null; then
        echo "✅ Pre-commit hooks installed successfully"
    else
        echo "⚠️  Failed to install pre-commit hooks (continuing anyway)"
    fi
else
    echo "ℹ️  No .pre-commit-config.yaml found, skipping pre-commit setup"
fi

echo "============================================"
echo "✅ Repository cloned and ready!"
echo "============================================"
echo ""
echo "📁 Directory: $TARGET_DIR"
echo "🌿 Branch:    $BRANCH_NAME (created automatically)"
echo ""
echo "⚠️  SAFETY: Direct pushes to main/master are BLOCKED"
echo ""
echo "Workflow:"
echo "  cd $TARGET_DIR"
echo "  # ... make changes ..."
echo "  git add . && git commit -m 'your message'"
echo "  git push -u origin $BRANCH_NAME"
echo "  # Use MCP create_pull_request tool to create a PR"
echo ""

