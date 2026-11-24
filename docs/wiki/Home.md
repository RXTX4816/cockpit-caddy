# Cockpit Caddy — User Guide

Cockpit Caddy is a web-based UI for managing [Caddy](https://caddyserver.com/), built as a plugin for [Cockpit](https://cockpit-project.org/). It runs in your browser and communicates with Caddy's Admin API on your server — no extra daemons required.

## What you can do

- Manage reverse proxies, static file servers (with SPA fallback and precompressed files), PHP sites, redirects, and static HTTP responses
- Several hostnames per site, and an IP as host to bind only that address
- **Named virtual servers** — group multiple routes under one port with per-route matchers
- **Route matchers** — match requests by path, host, method, header, query param, client or connection IP, with an exclude group and CEL expressions
- **Strip path prefix** (`handle_path`) — remove the matched prefix before forwarding to the upstream
- Search and filter entries by port, target, or label
- Add, edit, duplicate, and delete rules from the web UI
- Start, stop, restart, and reload the Caddy service
- Works with Caddy running externally (e.g. Docker) — see [Service Control: External mode](Service-Control#external-mode)
- HTTPS per site: automatic certificates (ACME / Let's Encrypt) for public hostnames, Caddy's internal CA for local names, or your own certificate; on-demand TLS per site
- ACME DNS challenge (for wildcards and hosts not reachable on ports 80/443), globally or per site, with credentials kept out of the Caddyfile
- Per-server access logging (with rotation), request body size limits, server timeouts, and transport tuning
- Extra upstreams with every Caddy load-balancing policy (including sticky sessions), retry/failover tuning, and passive and active health checks
- **Snippets** shared between sites (`import`)
- Trusted proxies and PROXY protocol support for running behind another load balancer or CDN
- Global Caddy options, Caddyfile viewer and editor with syntax highlighting, log table with filters, config health check, backup and restore, and internal CA / ACME certificate status windows
- Available in 24 languages; the UI follows Cockpit's language setting

## Pages

| Page | What it covers |
|---|---|
| [Proxy Dashboard](Proxy-Dashboard) | The main screen — entry list, status, search, and actions |
| [Managing Proxies](Managing-Proxies) | Add, edit, and delete rules |
| [Global Options](Global-Options) | Ports, ACME, DNS challenge, on-demand TLS, storage, metrics, trusted proxies, PROXY protocol, snippets |
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
