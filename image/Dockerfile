# Dockerfile for Sapphire Bee Sandbox Agent
# Provides: Claude Code CLI in a secure, sandboxed environment
# Target: Linux arm64/amd64
#
# Optimized for build cache efficiency and faster rebuilds

# --- Runtime image ---
FROM debian:bookworm-slim AS runtime

# Labels for image metadata
LABEL org.opencontainers.image.title="Sapphire Bee Sandbox Agent"
LABEL org.opencontainers.image.description="Sandboxed environment for Claude Code development"
LABEL org.opencontainers.image.source="https://github.com/SapphireBeehiveStudios/sapphire-bee"

# Use bash with pipefail for proper error handling in piped commands
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install all runtime dependencies in a single layer
# This layer will be cached unless dependencies change
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    git \
    ca-certificates \
    nodejs \
    npm \
    # Workflow tools
    curl \
    jq \
    zip \
    unzip \
    file \
    make \
    # Python for GitHub App token generation and testing
    python3 \
    python3-pip \
    python3-venv \
    # Build essentials for compiling dependencies
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Go 1.24 (required for CVE-2025-61729 and CVE-2025-61727 fixes)
# These CVEs affect crypto/x509 certificate validation - critical security vulnerabilities
# Download and install from official Go releases
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
        amd64) GO_ARCH=amd64 ;; \
        arm64) GO_ARCH=arm64 ;; \
        *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://go.dev/dl/go1.24.0.linux-${GO_ARCH}.tar.gz" -o /tmp/go.tar.gz && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm /tmp/go.tar.gz && \
    ln -s /usr/local/go/bin/go /usr/local/bin/go && \
    ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/claude/go"

# Install uv for Python package management (faster than pip)
# hadolint ignore=DL3013
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && uv pip install --system --break-system-packages \
        PyJWT \
        cryptography \
        requests \
        pre-commit \
        black \
        ruff \
        detect-secrets

# Install GitHub CLI (gh) for repo management (issues, PRs, etc.)
# hadolint ignore=DL3008
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI as root before user creation
# This ensures npm packages are installed globally and accessible
# Copy script first (separate layer) for better cacheability
COPY install/install_claude_code.sh /tmp/install_claude_code.sh
RUN chmod +x /tmp/install_claude_code.sh && \
    /tmp/install_claude_code.sh || \
    echo "WARNING: Claude Code installation incomplete - see logs above"

# Create user and directories in a single layer
# This layer is stable and rarely changes
RUN groupadd -g 1000 claude && \
    useradd -m -u 1000 -g claude -s /bin/bash claude && \
    mkdir -p /project /home/claude/.config /etc/claude && \
    chown -R claude:claude /project /home/claude

# Copy entrypoint script and set permissions in one layer
# Scripts change more frequently, so they're copied later
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/setup-github-app.sh /opt/scripts/setup-github-app.sh
COPY scripts/clone-repo.sh /opt/scripts/clone-repo.sh
COPY scripts/verify-mcp.sh /opt/scripts/verify-mcp.sh
COPY scripts/issue-worker.js /opt/scripts/issue-worker.js
RUN chmod +x /usr/local/bin/entrypoint.sh \
    /opt/scripts/setup-github-app.sh /opt/scripts/clone-repo.sh \
    /opt/scripts/verify-mcp.sh /opt/scripts/issue-worker.js

# Copy config files last (they change most frequently)
# This minimizes cache invalidation when only config changes
COPY config/claude-settings.json /etc/claude/settings.json
COPY config/sandbox-context.md /etc/claude/sandbox-context.md

# Set environment variables (stable, rarely changes)
ENV HOME=/home/claude
ENV USER=claude

# Switch to non-root user
USER claude
WORKDIR /project

# Entrypoint sets up Claude config on each container start
# (required because /home/claude is a tmpfs mount)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command - can be overridden
CMD ["bash"]

# Health check - verify core tools are available
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD claude --version || exit 1
