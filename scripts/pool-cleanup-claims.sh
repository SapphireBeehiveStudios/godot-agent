#!/bin/bash
# pool-cleanup-claims.sh - Clean up stale claim comments from issues
#
# This removes claim comments that workers posted but didn't complete
# (e.g., due to crashes, restarts, or race conditions)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=/dev/null
source "${PROJECT_ROOT}/.env" 2>/dev/null || true

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

usage() {
    cat << 'EOF'
Usage: ./scripts/pool-cleanup-claims.sh OWNER/REPO [LABEL]

Clean up stale claim comments from GitHub issues.

Arguments:
  OWNER/REPO    Repository (e.g., "myorg/myproject")
  LABEL         Issue label to filter (default: "agent-ready")

Examples:
  ./scripts/pool-cleanup-claims.sh myorg/myrepo
  ./scripts/pool-cleanup-claims.sh myorg/myrepo agent-ready

This script:
1. Finds all issues with the specified label
2. Looks for CLAIM:* comments
3. Removes claim comments that don't have corresponding in-progress labels
4. Removes in-progress labels from issues with no recent claim comments

Requires: gh CLI authenticated (run: gh auth login)
EOF
    exit 0
}

# Parse arguments
if [[ $# -lt 1 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
    usage
fi

REPO="$1"
LABEL="${2:-agent-ready}"

# Validate gh is installed and authenticated
if ! command -v gh &> /dev/null; then
    log_error "gh CLI is not installed. Install with: brew install gh"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    log_error "gh CLI is not authenticated. Run: gh auth login"
    exit 1
fi

log_info "Cleaning up stale claims in ${REPO}"
log_info "Looking for issues with label: ${LABEL}"
echo ""

# Get all open issues with the label
ISSUES=$(gh issue list -R "$REPO" -L 100 -l "$LABEL" --state open --json number,labels -q '.[].number')

if [[ -z "$ISSUES" ]]; then
    log_info "No issues found with label '${LABEL}'"
    exit 0
fi

TOTAL_ISSUES=$(echo "$ISSUES" | wc -l | tr -d ' ')
log_info "Found ${TOTAL_ISSUES} issues to check"
echo ""

CLAIMS_REMOVED=0
LABELS_REMOVED=0

# Check each issue
while IFS= read -r issue_num; do
    echo "Checking issue #${issue_num}..."

    # Get issue details
    ISSUE_DATA=$(gh issue view "$issue_num" -R "$REPO" --json labels,comments)

    # Check if issue has in-progress label
    HAS_IN_PROGRESS=$(echo "$ISSUE_DATA" | jq -r '.labels[] | select(.name == "in-progress") | .name' || echo "")

    # Get all CLAIM comments
    CLAIM_COMMENTS=$(echo "$ISSUE_DATA" | jq -r '.comments[] | select(.body | startswith("CLAIM:")) | "\(.id)|\(.createdAt)|\(.body)"')

    if [[ -z "$CLAIM_COMMENTS" ]]; then
        # No claim comments
        if [[ -n "$HAS_IN_PROGRESS" ]]; then
            log_warn "  Issue #${issue_num} has in-progress label but no claim comment - removing label"
            gh issue edit "$issue_num" -R "$REPO" --remove-label "in-progress" 2>/dev/null || log_error "Failed to remove label"
            ((LABELS_REMOVED++))
        fi
        continue
    fi

    # Count claim comments
    CLAIM_COUNT=$(echo "$CLAIM_COMMENTS" | wc -l | tr -d ' ')

    if [[ "$CLAIM_COUNT" -gt 1 ]]; then
        log_warn "  Issue #${issue_num} has ${CLAIM_COUNT} claim comments (race condition detected)"
    fi

    if [[ -z "$HAS_IN_PROGRESS" ]]; then
        # Has claim comments but no in-progress label - stale claims
        log_warn "  Issue #${issue_num} has ${CLAIM_COUNT} stale claim(s) - removing"

        while IFS='|' read -r comment_id created_at body; do
            worker_id=$(echo "$body" | cut -d':' -f2 || echo "unknown")
            echo "    Removing claim from worker: ${worker_id} (created: ${created_at})"

            gh api -X DELETE "/repos/${REPO}/issues/comments/${comment_id}" 2>/dev/null || \
                log_error "    Failed to delete comment ${comment_id}"

            ((CLAIMS_REMOVED++))
        done <<< "$CLAIM_COMMENTS"
    else
        # Has both claim and in-progress label - legitimate claim
        echo "  Issue #${issue_num} has valid claim (in-progress label present)"
    fi

    echo ""
done <<< "$ISSUES"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "Cleanup complete!"
echo ""
echo "  Issues checked:         ${TOTAL_ISSUES}"
echo "  Stale claims removed:   ${CLAIMS_REMOVED}"
echo "  Labels removed:         ${LABELS_REMOVED}"
echo ""

if [[ $((CLAIMS_REMOVED + LABELS_REMOVED)) -gt 0 ]]; then
    log_info "Workers should now be able to claim these issues"
else
    log_info "No stale claims found - everything looks good!"
fi
