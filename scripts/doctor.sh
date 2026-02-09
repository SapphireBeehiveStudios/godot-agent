#!/bin/bash
# doctor.sh - Health check for Sapphire Bee Sandbox environment
#
# Usage:
#   ./scripts/doctor.sh
#
# Checks:
#   - Docker installed and running
#   - Docker Compose available
#   - Required environment variables
#   - Image builds successfully
#   - Network connectivity within sandbox

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_DIR="${PROJECT_ROOT}/compose"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

check_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    ERRORS=$((ERRORS + 1))
}

check_warn() {
    echo -e "${YELLOW}!${NC} $1"
    WARNINGS=$((WARNINGS + 1))
}

check_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║             SAPPHIRE BEE SANDBOX HEALTH CHECK                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# === Docker Engine ===
echo "Docker Engine:"

if command -v docker &> /dev/null; then
    check_pass "Docker CLI found: $(which docker)"

    if docker info &> /dev/null; then
        check_pass "Docker daemon is running"

        # Check Docker version
        DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
        check_info "Docker version: $DOCKER_VERSION"

        # Check for Apple Silicon
        ARCH=$(uname -m)
        if [[ "$ARCH" == "arm64" ]]; then
            check_info "Running on Apple Silicon (arm64)"
        else
            check_info "Running on $ARCH"
        fi
    else
        check_fail "Docker daemon is not running"
        echo "       Start Docker Desktop or run: open -a Docker"
    fi
else
    check_fail "Docker CLI not found"
    echo "       Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
fi

echo ""

# === Docker Compose ===
echo "Docker Compose:"

if docker compose version &> /dev/null; then
    COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || echo "unknown")
    check_pass "Docker Compose found: $COMPOSE_VERSION"
elif command -v docker-compose &> /dev/null; then
    check_warn "Using legacy docker-compose (consider upgrading)"
else
    check_fail "Docker Compose not found"
fi

echo ""

# === Environment Variables ===
echo "Environment Variables:"

# Load .env if present
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    # shellcheck disable=SC1091
    source "${PROJECT_ROOT}/.env"
    check_pass ".env file found"
else
    check_warn ".env file not found (copy from .env.example)"
fi

# Check authentication methods (API key OR OAuth token)
HAS_AUTH=false

# Check for API key
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    if [[ "${ANTHROPIC_API_KEY}" =~ ^sk-ant- ]]; then
        check_pass "ANTHROPIC_API_KEY is set (starts with sk-ant-...)"
    else
        check_warn "ANTHROPIC_API_KEY is set but has unusual format"
    fi
    HAS_AUTH=true
else
    check_info "ANTHROPIC_API_KEY is not set"
fi

# Check for Claude Max OAuth token
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    if [[ "${CLAUDE_CODE_OAUTH_TOKEN}" =~ ^sk-ant- ]]; then
        check_pass "CLAUDE_CODE_OAUTH_TOKEN is set (Claude Max subscription)"
    else
        check_warn "CLAUDE_CODE_OAUTH_TOKEN is set but has unusual format"
    fi
    HAS_AUTH=true
else
    check_info "CLAUDE_CODE_OAUTH_TOKEN is not set"
fi

# Require at least one auth method
if [[ "$HAS_AUTH" == "false" ]]; then
    check_fail "No Claude authentication configured"
    echo "       Option 1: Run 'claude setup-token' then add CLAUDE_CODE_OAUTH_TOKEN to .env"
    echo "       Option 2: Add ANTHROPIC_API_KEY to .env file"
fi

echo ""

# === Project Structure ===
echo "Project Structure:"

REQUIRED_FILES=(
    "compose/compose.base.yml"
    "compose/compose.direct.yml"
    "compose/compose.staging.yml"
    "image/Dockerfile"
    "configs/coredns/Corefile"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [[ -f "${PROJECT_ROOT}/${file}" ]]; then
        check_pass "$file exists"
    else
        check_fail "$file missing"
    fi
done

echo ""

# === Compose Config Validation ===
echo "Compose Configuration:"

cd "$COMPOSE_DIR"

if docker compose -f compose.base.yml config &> /dev/null; then
    check_pass "compose.base.yml is valid"
else
    check_fail "compose.base.yml has errors"
    docker compose -f compose.base.yml config 2>&1 | head -5 | sed 's/^/       /'
fi

if docker compose -f compose.base.yml -f compose.direct.yml config &> /dev/null; then
    check_pass "compose.direct.yml is valid"
else
    check_fail "compose.direct.yml has errors"
fi

echo ""

# === Image Build Test ===
echo "Image Build:"

if docker images sapphire-bee:latest --format "{{.Repository}}" 2>/dev/null | grep -q "sapphire-bee"; then
    check_pass "Agent image exists"

    IMAGE_DATE=$(docker images sapphire-bee:latest --format "{{.CreatedAt}}" 2>/dev/null || echo "unknown")
    check_info "Image created: $IMAGE_DATE"
else
    check_warn "Agent image not built yet"
    echo "       Run: ./scripts/build.sh"
fi

echo ""

# === Network Test ===
echo "Network Configuration:"

# Check if sandbox network exists
if docker network ls --format "{{.Name}}" 2>/dev/null | grep -q "sapphire-bee-sandbox_sandbox_net"; then
    check_pass "Sandbox network exists"
else
    check_info "Sandbox network not created (will be created on first run)"
fi

echo ""

# === DNS Resolution Test (if services are running) ===
echo "Service Status:"

if docker compose -f compose.base.yml ps --quiet 2>/dev/null | grep -q .; then
    check_pass "Base services are running"

    # Test DNS resolution
    echo ""
    echo "DNS Resolution Test:"

    # Start a test container to check DNS
    TEST_RESULT=$(docker compose -f compose.base.yml -f compose.direct.yml run --rm --no-deps agent \
        sh -c "nslookup github.com 2>&1 || echo 'DNS_FAIL'" 2>/dev/null || echo "CONTAINER_FAIL")

    if [[ "$TEST_RESULT" != *"DNS_FAIL"* && "$TEST_RESULT" != *"CONTAINER_FAIL"* ]]; then
        check_pass "DNS resolution working for github.com"
    else
        check_warn "Could not test DNS resolution"
    fi
else
    check_info "Base services not running (start with ./scripts/up.sh)"
fi

echo ""

# === Summary ===
echo "════════════════════════════════════════════════════════════════"
if [[ $ERRORS -eq 0 && $WARNINGS -eq 0 ]]; then
    echo -e "${GREEN}All checks passed!${NC}"
elif [[ $ERRORS -eq 0 ]]; then
    echo -e "${YELLOW}$WARNINGS warning(s), but sandbox should work.${NC}"
else
    echo -e "${RED}$ERRORS error(s) found. Please fix before proceeding.${NC}"
fi
echo "════════════════════════════════════════════════════════════════"
echo ""

exit $ERRORS

