#!/usr/bin/env bash
set -euo pipefail

# pool-add-workers.sh - Add workers to existing pool without interrupting current workers
#
# This script bypasses Docker Compose scaling to avoid recreating existing containers.
# It manually creates new worker containers with the same configuration.

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get number of workers to add
WORKERS_TO_ADD="${1:-1}"

if ! [[ "$WORKERS_TO_ADD" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: WORKERS_TO_ADD must be a positive integer${NC}"
    exit 1
fi

echo -e "${GREEN}Adding ${WORKERS_TO_ADD} workers to existing pool...${NC}"

# Get current worker count
CURRENT_WORKERS=$(docker ps --filter "name=sapphire-bee-sandbox-worker-" --format "{{.Names}}" | wc -l | tr -d ' ')
echo "Current workers: $CURRENT_WORKERS"

# Find the highest worker number
if [ "$CURRENT_WORKERS" -eq 0 ]; then
    echo -e "${RED}Error: No workers currently running. Use 'make pool-start' instead.${NC}"
    exit 1
fi

HIGHEST_NUM=$(docker ps --filter "name=sapphire-bee-sandbox-worker-" --format "{{.Names}}" | \
    sed 's/sapphire-bee-sandbox-worker-//' | \
    sort -n | \
    tail -1)

echo "Highest worker number: $HIGHEST_NUM"

# Get a reference worker to copy configuration from
REFERENCE_WORKER="sapphire-bee-sandbox-worker-1"
if ! docker ps --filter "name=$REFERENCE_WORKER" --format "{{.Names}}" | grep -q "$REFERENCE_WORKER"; then
    REFERENCE_WORKER=$(docker ps --filter "name=sapphire-bee-sandbox-worker-" --format "{{.Names}}" | head -1)
fi

echo "Using $REFERENCE_WORKER as configuration reference"

# Extract configuration from reference worker
WORKER_IMAGE=$(docker inspect "$REFERENCE_WORKER" --format '{{.Config.Image}}')
WORKER_NETWORK=$(docker inspect "$REFERENCE_WORKER" --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}}{{end}}')

# Load environment from .env file
if [ -f .env ]; then
    set -a
    source .env
    set +a
else
    echo -e "${YELLOW}Warning: .env file not found${NC}"
fi

# Create new workers
for i in $(seq 1 "$WORKERS_TO_ADD"); do
    NEW_WORKER_NUM=$((HIGHEST_NUM + i))
    NEW_WORKER_NAME="sapphire-bee-sandbox-worker-${NEW_WORKER_NUM}"

    echo -e "${GREEN}Creating worker ${NEW_WORKER_NUM}...${NC}"

    # Create worker with same configuration as existing ones
    docker run -d \
        --name "$NEW_WORKER_NAME" \
        --hostname "$NEW_WORKER_NAME" \
        --network "$WORKER_NETWORK" \
        --dns 10.100.1.2 \
        --read-only \
        --tmpfs /tmp:size=100M,mode=1777 \
        --tmpfs /home/claude:size=50M,mode=0755,uid=1000,gid=1000 \
        --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --memory "${AGENT_MEMORY_LIMIT:-2G}" \
        --cpus "${AGENT_CPU_LIMIT:-2.0}" \
        --pids-limit 256 \
        --restart unless-stopped \
        --env ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
        --env CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
        --env GITHUB_REPO="${GITHUB_REPO:-}" \
        --env GITHUB_BRANCH="${GITHUB_BRANCH:-main}" \
        --env GITHUB_APP_ID="${GITHUB_APP_ID:-}" \
        --env GITHUB_APP_INSTALLATION_ID="${GITHUB_APP_INSTALLATION_ID:-}" \
        --env GITHUB_APP_PRIVATE_KEY="${GITHUB_APP_PRIVATE_KEY:-}" \
        --env GITHUB_APP_PRIVATE_KEY_PATH="${GITHUB_APP_PRIVATE_KEY_PATH:-}" \
        --env GITHUB_APP_REPOSITORIES="${GITHUB_APP_REPOSITORIES:-}" \
        --env ISSUE_LABEL="${ISSUE_LABEL:-agent-ready}" \
        --env POLL_INTERVAL="${POLL_INTERVAL:-60}" \
        --env HOME=/home/claude \
        --env USER=claude \
        --volume "${NEW_WORKER_NAME}_workspace:/project" \
        --volume "$(pwd)/secrets:/secrets:ro" \
        --volume "$(pwd)/image/scripts/issue-worker.js:/opt/scripts/issue-worker.js:ro" \
        --workdir /project \
        "$WORKER_IMAGE" \
        node /opt/scripts/issue-worker.js

    echo -e "${GREEN}Worker ${NEW_WORKER_NUM} created${NC}"
done

NEW_TOTAL=$((CURRENT_WORKERS + WORKERS_TO_ADD))
echo ""
echo -e "${GREEN}✓ Successfully added ${WORKERS_TO_ADD} workers${NC}"
echo -e "${GREEN}✓ Total workers now: ${NEW_TOTAL}${NC}"
echo ""
echo "Check status: make pool-status"
echo "View logs: make pool-logs"
