# Contributing to cockpit-caddy

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

### Requirements

- Node.js 22+
- npm
- Caddy (for manual testing)
- Cockpit 300+ (for testing in the UI)

### Local Setup

```bash
git clone https://github.com/RXTX4816/cockpit-caddy.git
cd cockpit-caddy
npm install
npm run build
```

To develop with live reload inside Cockpit, symlink the plugin:

```bash
mkdir -p ~/.local/share/cockpit
ln -s "$PWD/src" ~/.local/share/cockpit/cockpit-caddy
npm run watch
```

Then open http://localhost:9090 — Caddy Proxy appears in the sidebar automatically.

## Running Tests

```bash
npm run test          # Run unit tests once
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### E2E Browser Tests

E2E tests run against a real Cockpit VM via Playwright. Each distro (arch/debian/fedora) is a Playwright project:

```bash
npm run test:e2e                          # All running VMs
npm run test:e2e -- --project=arch        # Target a specific VM
npm run test:e2e -- --project=arch --project=debian
npm run test:e2e:ui                       # Visual runner (step-by-step debugging)
BASE_URL=https://localhost:9093 npm run test:e2e:codegen  # Record a new test
```

Start and wait for a VM before running:

```bash
npm run vm start arch
npm run vm wait arch
npm run vm status     # Show all VMs with ports
```

See [docs/wiki/VM-Testing.md](docs/wiki/VM-Testing.md) for full VM setup instructions.

## Code Quality

```bash
npm run lint       # ESLint
npm run typecheck  # TypeScript type checking
npm run build      # Production build (minified)
```

All of these run automatically in CI. Your PR must pass all checks before merging.

## Commit Conventions

This project uses semantic versioning driven by commit messages:

- **Patch bump** (v1.0.0 → v1.0.1): Regular bugfixes and improvements
- **Minor bump** (v1.0.0 → v1.1.0): Features. Commit messages starting with `feat:` (e.g. `feat: add log viewer`)
- **Major bump** (v1.0.0 → v2.0.0): Breaking changes. Include `BREAKING CHANGE:` in the commit body

Examples:

```
feat: add Caddyfile editor tab

fix: correct TLS toggle state on reload

chore: update PatternFly to 6.5.0
```

## Pull Requests

1. **One feature per PR** — keep PRs focused and reviewable
2. **CI must pass** — lint, typecheck, tests, and build all run automatically
3. **Add tests** — if your change is a feature or bugfix, add a test to prevent regression
4. **Update docs** — if user-facing behavior changes, update README or comments as needed
5. **Describe what and why** — a clear PR description helps understand the motivation

## Reporting Issues

- **Bug?** Open an issue, include Caddy version, OS, and steps to reproduce
- **Feature request?** Open an issue describing the problem being solved
- **Security vulnerability?** Do **not** open a public issue — follow the [Security Policy](SECURITY.md) to report it privately

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
