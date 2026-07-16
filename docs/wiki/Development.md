# Development

How to set up a local development environment for cockpit-caddy.

## Requirements

- Node.js 22+
- npm
- A running Cockpit instance (local or VM) for live testing

## Setup

```bash
git clone https://github.com/RXTX4816/cockpit-caddy.git
cd cockpit-caddy
npm install
npm run build
```

To develop with live reload inside Cockpit, symlink the plugin's `src/` directory into Cockpit's local plugin path:

```bash
mkdir -p ~/.local/share/cockpit
ln -s "$PWD/src" ~/.local/share/cockpit/cockpit-caddy
npm run watch
```

Open `http://localhost:9090` — **Caddy** appears in the sidebar automatically. Changes to source files are picked up immediately without restarting Cockpit.

## Commands

| Command | Description |
|---|---|
| `npm run build` | Production build |
| `npm run watch` | Build with file watching |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` | ESLint |
| `npm run test` | Run tests |
| `npm run test:coverage` | Coverage report |

## Plugin Base

Build scripts, shared TypeScript/ESLint/Vitest config, and the VM test runner are provided by [`@rxtx4816/cockpit-plugin-base-react`](https://github.com/RXTX4816/cockpit-plugin-base-react), installed automatically as a devDependency via `npm install`. You do not need to clone or configure it separately.

The package supplies:

- `tsconfig.base.json` — base TypeScript configuration extended by `tsconfig.json`
- `vitest.config.base.ts` — base Vitest configuration extended by `vitest.config.ts`
- `eslint.config.base.js` — base ESLint rules extended by `eslint.config.js`
- `scripts/test-vm.sh` — VM testing script (exposed as `npm run vm`)

## VM Testing

`npm run vm` wraps the `test-vm.sh` script from `cockpit-plugin-base-react` to spin up QEMU VMs for end-to-end testing across distros. Your `src/` folder is mounted live, so `npm run watch` changes appear in the browser immediately.

```bash
sudo pacman -S qemu-full cloud-image-utils wget   # Arch one-time deps
npm run build
npm run vm init   # download base images and start VMs
```

See the [cockpit-plugin-base-react](https://github.com/RXTX4816/cockpit-plugin-base-react) repo for the full VM command reference, and [E2E Test Coverage](E2E-Test-Coverage) for what the Playwright suite already tests.

## Project structure

```
src/
  api/           Caddy Admin API + systemd wrappers
  components/    React UI components
  hooks/         Data-fetching hooks (useCaddyConfig, useProxies, …)
  i18n/          i18next setup and locale JSON files
  test/          Test helpers and setup
docs/
  wiki/          GitHub Wiki source (synced by CI on push to main)
```

## Translations

UI strings live in `src/i18n/locales/en.json`. To add a language, copy that file, translate the values, and register it in `src/i18n/index.ts`. Open a PR — the i18n coverage table in the README is updated automatically on build.
