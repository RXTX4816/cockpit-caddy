# Cockpit Caddy Plugin

[![CI](https://github.com/RXTX4816/cockpit-caddy/actions/workflows/ci.yml/badge.svg)](https://github.com/RXTX4816/cockpit-caddy/actions/workflows/ci.yml)
[![Packaging](https://github.com/RXTX4816/cockpit-caddy/actions/workflows/pkg-ci.yml/badge.svg)](https://github.com/RXTX4816/cockpit-caddy/actions/workflows/pkg-ci.yml)

Caddy reverse proxy management for [Cockpit](https://cockpit-project.org)

## Concept

Each service gets its own HTTPS port on your local machine:

```
https://192.168.1.100:8443  →  localhost:8080  (Nextcloud)
https://192.168.1.100:8444  →  localhost:3000 
https://192.168.1.100:8445  →  10.0.0.5:9000 
```

Caddy handles TLS automatically via its internal CA (`tls internal`). No DNS, no subdomains, no Let's Encrypt required.

## Features

- Dashboard listing all reverse proxy rules with status
- Add / edit / delete proxy rules from the web UI
- Start, stop, restart, and reload the Caddy service
- TLS self-signed certificates via Caddy's internal CA (enabled by default)
- Search and filter proxies by port, target, or label
- Caddyfile editor tab (coming in v0.2)
- Log viewer tab (coming in v0.2)
- 24 language support (UI follows Cockpit's language setting)

## Requirements

- Cockpit 300+
- Caddy (any recent version with Admin API support)
- Caddy Admin API enabled (default: `localhost:2019`)

## Installation

### Arch Linux

```bash
paru -S cockpit-caddy
```

### Fedora / RHEL / CentOS Stream / openSUSE

Download the `.rpm` from the [Releases](https://github.com/RXTX4816/cockpit-caddy/releases) page:

```bash
sudo rpm -i cockpit-caddy-X.Y.Z-1.noarch.rpm
```

### Debian / Ubuntu / Linux Mint / Pop!\_OS

Download the `.deb` from the [Releases](https://github.com/RXTX4816/cockpit-caddy/releases) page:

```bash
sudo apt install ./cockpit-caddy_X.Y.Z-1_all.deb
```

### Manual

Download the latest release tarball from the [Releases](https://github.com/RXTX4816/cockpit-caddy/releases) page:

```bash
tar -xzf cockpit-caddy-X.Y.Z.tar.gz
sudo mkdir -p /usr/share/cockpit/cockpit-caddy
sudo cp -r cockpit-caddy/* /usr/share/cockpit/cockpit-caddy/
```

Then open Cockpit in your browser or hard-refresh the page — **Caddy Proxy** appears in the left navigation.

## Caddy Setup

Install Caddy and enable it as a systemd service:

```bash
# Arch
sudo pacman -S caddy
sudo systemctl enable --now caddy

# Debian/Ubuntu
sudo apt install caddy
sudo systemctl enable --now caddy

# Fedora
sudo dnf install caddy
sudo systemctl enable --now caddy
```

The Admin API is enabled by default at `localhost:2019`. Verify with:

```bash
curl http://localhost:2019/config/
```

## Development

**Requirements:** Node.js 22+, npm

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

Open `http://localhost:9090` — **Caddy Proxy** appears in the sidebar automatically.

| Command | Description |
|---|---|
| `npm run build` | Production build |
| `npm run watch` | Build with file watching |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | ESLint |
| `npm run test` | Run unit tests |
| `npm run test:coverage` | Coverage report |
| `npm run test:e2e` | Run E2E browser tests (requires a running VM) |
| `npm run test:e2e:ui` | E2E tests in the Playwright visual runner |

### VM Testing

For testing in real browser environments across Arch, Debian, and Fedora, the `npm run vm` command manages local QEMU VMs. See [docs/wiki/VM-Testing.md](docs/wiki/VM-Testing.md) for setup and usage.

### Plugin Base

Build scripts, shared TypeScript/ESLint/Vitest config, the VM test runner, and Playwright fixtures are provided by [`@rxtx4816/cockpit-plugin-base-react`](https://github.com/RXTX4816/cockpit-plugin-base-react), installed automatically as a devDependency via `npm install`. You do not need to clone or configure it separately.

## Translations

The UI language follows Cockpit's language setting.

<!-- i18n-coverage-start -->
| Coverage | Languages |
|---|---|
| 100% | English (`en`) — source |
| 49% | `ar`, `cs`, `de`, `es`, `fi`, `fr`, `he`, `id`, `it`, `ja`, `ka`, `ko`, `nl`, `pl`, `pt-BR`, `ro`, `ru`, `sk`, `sv`, `tr`, `uk`, `zh-CN`, `zh-TW` |
<!-- i18n-coverage-end -->

To add or improve a translation, copy `src/i18n/locales/en.json`, translate the values, and open a PR.

## Contributing

Bug reports and feature requests: open an issue on [GitHub](https://github.com/RXTX4816/cockpit-caddy/issues).

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and development setup.

## License

MIT
