# Proxy Dashboard

The Proxy Dashboard is the main screen of the Cockpit Caddy plugin. It lists all entries currently configured in Caddy and shows the service status at a glance.

## Layout

The page is divided into three areas:

1. **Tab bar** — switches between Proxies, Logs, Caddyfile, and Settings tabs.
2. **Service Control bar** — shows the Caddy service status (running/stopped) and action buttons (Start, Stop, Restart, Reload). See [Service Control](Service-Control).
3. **Entry list** — a table of all configured rules.

## Entry types

| Type | What it does |
|---|---|
| **Proxy** | Forwards traffic to an upstream service (`reverse_proxy`) |
| **Static** | Serves files from a directory (`file_server`) |
| **Redirect** | Issues an HTTP redirect to another URL |
| **Respond** | Returns a static HTTP response (status code + optional body) |

## Entry list columns

| Column | Description |
|---|---|
| Label | Optional human-readable name for the rule |
| Port | The external port Caddy listens on (e.g. `8443`) |
| Type | Proxy, Static, Redirect, or Respond |
| Target / Root | Upstream address (proxy) or root directory (static) |
| TLS | Whether Caddy's internal CA is used |
| Flags | Active optional features (compress, auth, access log, timeouts, …) |
| Actions | Edit, duplicate, and delete buttons |

## Search and filter

The search bar filters entries in real time across port, target/root, label, and type.

## Adding entries

The toolbar has four **Add** buttons:

- **Add Proxy** — reverse proxy to an upstream service
- **Add Static** — static file server from a directory
- **Add Redirect** — HTTP redirect rule
- **Add Respond** — static HTTP response

Each opens a dialog. See [Managing Entries](Managing-Proxies) for field details.

## Other tabs

| Tab | Description |
|---|---|
| **Logs** | Live Caddy log viewer with level filtering and search |
| **Caddyfile** | Raw Caddyfile editor with syntax validation |
| **Settings** | Global Caddy options (ports, debug mode, shutdown delays) and Internal CA viewer |

## Empty state

If no entries are configured, the list shows a prompt to add the first rule. This does not indicate a problem with Caddy — it simply means the Caddyfile has no managed blocks yet.
