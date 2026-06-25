# Cockpit Caddy — User Guide

Cockpit Caddy is a web-based UI for managing [Caddy](https://caddyserver.com/), built as a plugin for [Cockpit](https://cockpit-project.org/). It runs in your browser and communicates with Caddy's Admin API on your server — no extra daemons required.

## What you can do

- Manage reverse proxies, static file servers, redirects, and static HTTP responses
- Search and filter entries by port, target, or label
- Add, edit, duplicate, and delete rules from the web UI
- Start, stop, restart, and reload the Caddy service
- TLS certificates handled automatically via Caddy's internal CA — no DNS or Let's Encrypt required
- Per-server access logging, server timeouts, and transport tuning
- Global Caddy options, Caddyfile editor, log viewer, and internal CA viewer

## Pages

| Page | What it covers |
|---|---|
| [Proxy Dashboard](Proxy-Dashboard) | The main screen — entry list, status, search, and actions |
| [Managing Proxies](Managing-Proxies) | Add, edit, and delete rules |
| [Service Control](Service-Control) | Start, stop, restart, and reload the Caddy service |
| [Troubleshooting](Troubleshooting) | Fixes for common installation and runtime problems |
| [Development](Development) | Dev setup, build commands, plugin-base, and VM testing |

## Interface conventions

**Status colors** are used consistently throughout the UI:

| Color | Meaning |
|---|---|
| Green | Service running / rule active |
| Grey | Service stopped |
| Red | Error or unreachable |

**Confirmation dialogs** appear before any destructive action (delete proxy rule). Read them carefully — deleted rules cannot be recovered.

**Buttons are disabled** while an operation is in progress. A spinner appears to indicate work is happening.

## Getting help

- Check [Troubleshooting](Troubleshooting) for common installation and runtime problems.
- Open a [GitHub issue](https://github.com/RXTX4816/cockpit-caddy/issues) to report bugs or request features.
