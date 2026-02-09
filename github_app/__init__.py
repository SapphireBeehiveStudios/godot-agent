# GitHub App Authentication for Sapphire Bee MCP Integration
#
# This module provides GitHub App authentication to generate short-lived
# installation tokens for the GitHub MCP server.
#
# Usage:
#   from github_app import GitHubAppTokenGenerator
#
#   generator = GitHubAppTokenGenerator(
#       app_id="123456",
#       private_key_path="./secrets/github-app-private-key.pem",
#       installation_id="12345678"
#   )
#   token = generator.generate_installation_token()

from .token_generator import GitHubAppTokenGenerator
from .mcp_config import MCPConfigGenerator

__all__ = ["GitHubAppTokenGenerator", "MCPConfigGenerator"]



