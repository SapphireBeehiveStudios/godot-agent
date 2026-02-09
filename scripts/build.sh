#!/bin/bash
# build.sh - Build the Sapphire Bee agent container image
#
# Usage:
#   ./scripts/build.sh
#   ./scripts/build.sh --no-cache

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_DIR="${PROJECT_ROOT}/image"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
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

# Parse arguments
NO_CACHE=""
if [[ "${1:-}" == "--no-cache" ]]; then
    NO_CACHE="--no-cache"
fi

log_info "Building Sapphire Bee agent image"
echo ""

log_info "Building image..."

cd "$IMAGE_DIR"

docker build \
    $NO_CACHE \
    -t sapphire-bee:latest \
    .

log_info "Build complete!"
echo ""
echo "Image: sapphire-bee:latest"
echo ""
echo "To verify:"
echo "  docker run --rm sapphire-bee:latest claude --version"
echo ""
echo "To run Claude:"
echo "  make up-agent PROJECT=/path/to/project"
echo "  make claude"

