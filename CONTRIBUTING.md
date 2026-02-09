# Contributing to Sapphire Bee

Thank you for your interest in contributing to Sapphire Bee! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help maintain a welcoming environment for all contributors

## How to Contribute

### Reporting Issues

Before creating an issue, please:
1. Check if the issue already exists
2. Provide clear reproduction steps
3. Include relevant environment details (OS, Docker version, etc.)
4. Add logs if applicable (from `logs/` directory)

### Submitting Pull Requests

1. **Fork and Clone**
   ```bash
   git clone https://github.com/your-username/sapphire-bee.git
   cd sapphire-bee
   ```

2. **Create a Branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

3. **Make Your Changes**
   - Follow the project conventions (see CLAUDE.md)
   - Test your changes thoroughly
   - Run `make doctor` to verify setup
   - Run `make ci` to test locally with act (if available)

4. **Commit Your Changes**

   Use conventional commit messages:
   ```
   type(scope): short description

   Optional longer explanation of the change.

   Fixes #123
   ```

   Types:
   - `feat`: New feature
   - `fix`: Bug fix
   - `docs`: Documentation changes
   - `ci`: CI/CD changes
   - `build`: Build system changes
   - `chore`: Maintenance tasks
   - `refactor`: Code refactoring
   - `test`: Test additions or changes

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature-name
   ```
   Then create a pull request on GitHub with a clear description.

## Development Guidelines

### Shell Scripts

- Use `set -euo pipefail` at the top of all scripts
- Run `shellcheck` for linting
- Add comments explaining non-obvious logic
- Make scripts executable: `chmod +x scripts/script-name.sh`

### Docker and Compose

- Use modern Docker Compose syntax (v3.8+)
- Default environment variables to empty: `${VAR:-}`
- Never require secrets in CI pipelines
- Test changes with `make build` and `make up`

### Documentation

- Update README.md for user-facing changes
- Update CLAUDE.md for architectural or workflow changes
- Add inline comments for complex logic
- Keep documentation accurate and up-to-date

### Security

- Never commit secrets (API keys, tokens, etc.)
- Test security boundaries when modifying:
  - Network allowlists (`configs/coredns/`)
  - Proxy configurations (`configs/nginx/`)
  - Container security settings (Dockerfile, compose files)
- Run `make scan PROJECT=/path` to check for dangerous patterns

## Testing

### Local Testing

```bash
# Build the container
make build

# Start infrastructure
make up

# Test with a project
make run-direct PROJECT=/path/to/test/project

# Run CI locally (requires act)
make ci

# Stop everything
make down
```

### Testing Checklist

- [ ] Code builds without errors
- [ ] Changes work with both direct and staging modes
- [ ] Documentation is updated
- [ ] No secrets committed
- [ ] Shell scripts pass shellcheck
- [ ] CI pipeline passes (if applicable)

## Project Structure

Understanding the structure helps you know where to make changes:

```
sapphire-bee/
├── compose/          # Docker Compose files - modify for service changes
├── configs/          # Service configurations - modify for network/proxy changes
├── image/            # Container build - modify for tooling changes
├── scripts/          # Operational scripts - add new automation here
├── .github/          # CI/CD - modify for workflow changes
└── docs/             # Additional documentation
```

## Getting Help

- Check CLAUDE.md for architecture and conventions
- Review existing issues and PRs
- Open a discussion on GitHub for questions
- Reach out to maintainers for guidance

## Review Process

1. Automated checks must pass (CI pipeline)
2. At least one maintainer review required
3. All conversations must be resolved
4. Branch must be up-to-date with main

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
