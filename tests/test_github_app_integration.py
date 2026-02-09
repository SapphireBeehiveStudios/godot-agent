"""
Integration tests for GitHub App MCP integration.

Tests the container-level integration including:
- Python dependencies installed
- Scripts available and executable
- Configuration files present
- Environment variable handling

Note: These tests use `docker run` directly instead of compose
to avoid networking conflicts with fixed IP addresses.
"""

import subprocess
import tempfile
import time
from pathlib import Path

import pytest


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture(scope="module")
def docker_image():
    """Ensure the docker image is available."""
    # Check if image exists
    result = subprocess.run(
        ["docker", "images", "-q", "sapphire-bee:latest"],
        capture_output=True,
        text=True,
    )
    if not result.stdout.strip():
        pytest.skip("Docker image not built. Run 'make build' first.")

    return "sapphire-bee:latest"


@pytest.fixture(scope="module")
def temp_project(tmp_path_factory):
    """Create a temporary project directory."""
    return tmp_path_factory.mktemp("project")


def run_in_container(image: str, command: list[str], env: dict = None, project_path: str = None) -> subprocess.CompletedProcess:
    """Run a command in the container without compose networking."""
    docker_cmd = ["docker", "run", "--rm"]
    
    # Add environment variables
    if env:
        for key, value in env.items():
            docker_cmd.extend(["-e", f"{key}={value}"])
    
    # Add project mount if provided
    if project_path:
        docker_cmd.extend(["-v", f"{project_path}:/project"])
    
    docker_cmd.append(image)
    docker_cmd.extend(command)
    
    return subprocess.run(
        docker_cmd,
        capture_output=True,
        text=True,
        timeout=60,
    )


# =============================================================================
# Python Dependencies Tests
# =============================================================================

class TestPythonDependencies:
    """Test that Python dependencies for GitHub App are available."""
    
    def test_python3_available(self, docker_image):
        """Test Python 3 is installed."""
        result = run_in_container(docker_image, ["python3", "--version"])
        
        assert result.returncode == 0, f"python3 failed: {result.stderr}"
        assert "Python 3" in result.stdout
    
    def test_pyjwt_installed(self, docker_image):
        """Test PyJWT is installed."""
        result = run_in_container(
            docker_image,
            ["python3", "-c", "import jwt; print('jwt available')"]
        )
        
        assert result.returncode == 0, f"PyJWT not available: {result.stderr}"
        assert "jwt available" in result.stdout
    
    def test_cryptography_installed(self, docker_image):
        """Test cryptography is installed."""
        result = run_in_container(
            docker_image,
            ["python3", "-c", "import cryptography; print('cryptography available')"]
        )
        
        assert result.returncode == 0, f"cryptography not available: {result.stderr}"
        assert "cryptography available" in result.stdout
    
    def test_requests_installed(self, docker_image):
        """Test requests is installed."""
        result = run_in_container(
            docker_image,
            ["python3", "-c", "import requests; print('requests available')"]
        )
        
        assert result.returncode == 0, f"requests not available: {result.stderr}"
        assert "requests available" in result.stdout


# =============================================================================
# Script Availability Tests
# =============================================================================

class TestGitHubAppScriptAvailable:
    """Test that setup-github-app.sh is available and valid."""
    
    def test_setup_script_exists(self, docker_image):
        """Test setup-github-app.sh exists in container."""
        result = run_in_container(
            docker_image,
            ["test", "-f", "/opt/scripts/setup-github-app.sh"]
        )
        
        assert result.returncode == 0, "setup-github-app.sh not found"
    
    def test_setup_script_executable(self, docker_image):
        """Test setup-github-app.sh is executable."""
        result = run_in_container(
            docker_image,
            ["test", "-x", "/opt/scripts/setup-github-app.sh"]
        )
        
        assert result.returncode == 0, "setup-github-app.sh not executable"
    
    def test_setup_script_has_shebang(self, docker_image):
        """Test setup-github-app.sh has proper shebang."""
        result = run_in_container(
            docker_image,
            ["head", "-1", "/opt/scripts/setup-github-app.sh"]
        )
        
        assert result.returncode == 0
        assert "#!/bin/bash" in result.stdout
    
    def test_entrypoint_exists(self, docker_image):
        """Test entrypoint.sh exists."""
        result = run_in_container(
            docker_image,
            ["test", "-f", "/usr/local/bin/entrypoint.sh"]
        )
        
        assert result.returncode == 0, "entrypoint.sh not found"


# =============================================================================
# Sandbox Context Tests
# =============================================================================

class TestSandboxContext:
    """Test that sandbox-context.md is properly installed."""
    
    def test_sandbox_context_source_exists(self, docker_image):
        """Test sandbox-context.md exists in /etc/claude."""
        result = run_in_container(
            docker_image,
            ["test", "-f", "/etc/claude/sandbox-context.md"]
        )
        
        assert result.returncode == 0, "sandbox-context.md not found in /etc/claude"
    
    def test_sandbox_context_readable(self, docker_image):
        """Test sandbox-context.md can be read."""
        result = run_in_container(
            docker_image,
            ["cat", "/etc/claude/sandbox-context.md"]
        )
        
        assert result.returncode == 0, f"Cannot read sandbox-context.md: {result.stderr}"
        assert len(result.stdout) > 100, "sandbox-context.md seems empty"
    
    def test_sandbox_context_mentions_mcp(self, docker_image):
        """Test sandbox-context.md mentions MCP tools."""
        result = run_in_container(
            docker_image,
            ["grep", "-i", "mcp", "/etc/claude/sandbox-context.md"]
        )
        
        assert result.returncode == 0, "sandbox-context.md should mention MCP"
        assert "MCP" in result.stdout or "mcp" in result.stdout
    
    def test_sandbox_context_mentions_github(self, docker_image):
        """Test sandbox-context.md mentions GitHub."""
        result = run_in_container(
            docker_image,
            ["grep", "-i", "github", "/etc/claude/sandbox-context.md"]
        )
        
        assert result.returncode == 0, "sandbox-context.md should mention GitHub"


# =============================================================================
# Claude Settings Tests
# =============================================================================

class TestClaudeSettings:
    """Test that Claude settings are properly installed."""
    
    def test_claude_settings_exists(self, docker_image):
        """Test claude-settings.json exists in /etc/claude."""
        result = run_in_container(
            docker_image,
            ["test", "-f", "/etc/claude/settings.json"]
        )
        
        assert result.returncode == 0, "settings.json not found in /etc/claude"
    
    def test_claude_settings_valid_json(self, docker_image):
        """Test claude-settings.json is valid JSON."""
        result = run_in_container(
            docker_image,
            ["python3", "-c", "import json; json.load(open('/etc/claude/settings.json'))"]
        )
        
        assert result.returncode == 0, f"settings.json is not valid JSON: {result.stderr}"


# =============================================================================
# Environment Variable Tests
# =============================================================================

class TestGitHubAppEnvironmentVariables:
    """Test that GitHub App env vars are passed correctly."""
    
    def test_github_app_id_passed(self, docker_image):
        """Test GITHUB_APP_ID is accessible in container."""
        result = run_in_container(
            docker_image,
            ["printenv", "GITHUB_APP_ID"],
            env={"GITHUB_APP_ID": "test_app_id_123"}
        )
        
        assert result.returncode == 0
        assert "test_app_id_123" in result.stdout
    
    def test_github_app_installation_id_passed(self, docker_image):
        """Test GITHUB_APP_INSTALLATION_ID is accessible in container."""
        result = run_in_container(
            docker_image,
            ["printenv", "GITHUB_APP_INSTALLATION_ID"],
            env={"GITHUB_APP_INSTALLATION_ID": "test_install_456"}
        )
        
        assert result.returncode == 0
        assert "test_install_456" in result.stdout
    
    def test_multiple_env_vars(self, docker_image):
        """Test multiple GitHub App env vars can be passed."""
        result = run_in_container(
            docker_image,
            ["bash", "-c", "echo $GITHUB_APP_ID:$GITHUB_APP_INSTALLATION_ID"],
            env={
                "GITHUB_APP_ID": "app123",
                "GITHUB_APP_INSTALLATION_ID": "install456"
            }
        )
        
        assert result.returncode == 0
        assert "app123:install456" in result.stdout


# =============================================================================
# uv Package Manager Tests
# =============================================================================

class TestUvPackageManager:
    """Test that uv is installed and working."""
    
    def test_uv_installed(self, docker_image):
        """Test uv is installed in container."""
        result = run_in_container(
            docker_image,
            ["which", "uv"]
        )
        
        assert result.returncode == 0, f"uv not found: {result.stderr}"
        assert "uv" in result.stdout
    
    def test_uv_version(self, docker_image):
        """Test uv can report its version."""
        result = run_in_container(
            docker_image,
            ["uv", "--version"]
        )
        
        assert result.returncode == 0, f"uv --version failed: {result.stderr}"
        assert "uv" in result.stdout


# =============================================================================
# User and Permissions Tests
# =============================================================================

class TestContainerUser:
    """Test container user configuration."""
    
    def test_runs_as_claude_user(self, docker_image):
        """Test container runs as claude user."""
        result = run_in_container(
            docker_image,
            ["whoami"]
        )
        
        assert result.returncode == 0
        assert "claude" in result.stdout
    
    def test_home_directory(self, docker_image):
        """Test home directory is /home/claude."""
        result = run_in_container(
            docker_image,
            ["bash", "-c", "echo $HOME"]
        )
        
        assert result.returncode == 0
        assert "/home/claude" in result.stdout


# =============================================================================
# Entrypoint Behavior Tests
# =============================================================================

class TestEntrypointBehavior:
    """Test entrypoint script behavior."""
    
    def test_entrypoint_creates_claude_config_dir(self, docker_image):
        """Test entrypoint creates ~/.claude directory."""
        # Run with entrypoint (default)
        result = subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "/usr/local/bin/entrypoint.sh",
             docker_image, "test", "-d", "/home/claude/.claude"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        
        assert result.returncode == 0, "~/.claude directory not created"
    
    def test_entrypoint_copies_sandbox_context(self, docker_image):
        """Test entrypoint copies sandbox-context.md to ~/.claude/CLAUDE.md."""
        result = subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "/usr/local/bin/entrypoint.sh",
             docker_image, "test", "-f", "/home/claude/.claude/CLAUDE.md"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        
        assert result.returncode == 0, "CLAUDE.md not created by entrypoint"
    
    def test_entrypoint_skips_github_app_without_config(self, docker_image):
        """Test entrypoint skips GitHub App setup when not configured."""
        # This should not fail even without GitHub App env vars
        result = subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "/usr/local/bin/entrypoint.sh",
             docker_image, "echo", "success"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        
        assert result.returncode == 0, f"Entrypoint failed: {result.stderr}"
        assert "success" in result.stdout


# =============================================================================
# DNS and Network Configuration Tests (Static)
# =============================================================================

class TestNetworkConfiguration:
    """Test network configuration files."""
    
    def test_hosts_allowlist_includes_api_github(self):
        """Test hosts.allowlist includes api.github.com."""
        project_root = Path(__file__).parent.parent
        hosts_file = project_root / "configs" / "coredns" / "hosts.allowlist"
        
        content = hosts_file.read_text()
        assert "api.github.com" in content, "api.github.com not in allowlist"
        assert "10.100.1.15" in content, "api.github.com proxy IP not in allowlist"
    
    def test_corefile_includes_api_github(self):
        """Test Corefile includes api.github.com."""
        project_root = Path(__file__).parent.parent
        corefile = project_root / "configs" / "coredns" / "Corefile"
        
        content = corefile.read_text()
        assert "api.github.com" in content, "api.github.com not in Corefile"
    
    def test_proxy_github_api_config_exists(self):
        """Test proxy_github_api.conf exists."""
        project_root = Path(__file__).parent.parent
        proxy_conf = project_root / "configs" / "nginx" / "proxy_github_api.conf"
        
        assert proxy_conf.exists(), "proxy_github_api.conf not found"
        content = proxy_conf.read_text()
        assert "api.github.com" in content


# =============================================================================
# Compose Configuration Tests (Static)
# =============================================================================

class TestComposeConfiguration:
    """Test compose file configuration."""
    
    def test_compose_base_includes_github_api_proxy(self):
        """Test compose.base.yml includes proxy_github_api service."""
        project_root = Path(__file__).parent.parent
        compose_file = project_root / "compose" / "compose.base.yml"
        
        content = compose_file.read_text()
        assert "proxy_github_api" in content, "proxy_github_api not in compose.base.yml"
        assert "10.100.1.15" in content, "proxy_github_api IP not in compose.base.yml"
    
    def test_compose_direct_includes_github_app_vars(self):
        """Test compose.direct.yml includes GitHub App env vars."""
        project_root = Path(__file__).parent.parent
        compose_file = project_root / "compose" / "compose.direct.yml"
        
        content = compose_file.read_text()
        assert "GITHUB_APP_ID" in content
        assert "GITHUB_APP_INSTALLATION_ID" in content
        assert "GITHUB_APP_PRIVATE_KEY" in content
    
    def test_compose_persistent_includes_github_app_vars(self):
        """Test compose.persistent.yml includes GitHub App env vars."""
        project_root = Path(__file__).parent.parent
        compose_file = project_root / "compose" / "compose.persistent.yml"
        
        content = compose_file.read_text()
        assert "GITHUB_APP_ID" in content
        assert "GITHUB_APP_INSTALLATION_ID" in content
