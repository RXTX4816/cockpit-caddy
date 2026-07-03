# Proxy Dashboard

The Proxy Dashboard is the main screen of the Cockpit Caddy plugin. It lists all entries currently configured in Caddy and shows the service status at a glance.

## Layout

The page is divided into three areas:

1. **Tab bar** — switches between Proxies, Logs, Caddyfile, and Settings tabs.
2. **Service Control bar** — shows the Caddy service status (running/stopped) and action buttons (Start, Stop, Restart, Reload). See [Service Control](Service-Control).
3. **Entry list** — entries grouped by server tabs (see below).

## Server tabs

The entry list is split into tabs:

| Tab | What it shows |
|---|---|
| **All** | Every entry across all servers and standalone rules |
| **[Server name]** | Routes belonging to a specific named server — one tab per server |

The **All** tab shows standalone entries and all named-server routes in a flat list with a server badge on each row that belongs to a named server.

Each named-server tab shows a **server info card** at the top (listen addresses as clickable links, TLS state, timeouts) followed by a routes table with matcher, label, type, target, and a clickable port/path link per route.

## Entry types

| Type | What it does |
|---|---|
| **Proxy** | Forwards traffic to an upstream service (`reverse_proxy`) |
| **Static** | Serves files from a directory (`file_server`) |
| **Redirect** | Issues an HTTP redirect to another URL |
| **Respond** | Returns a static HTTP response (status code + optional body) |

## All-tab columns

| Column | Description |
|---|---|
| Label | Optional human-readable name for the rule |
| Port | The external port Caddy listens on — click to open the URL in a new tab |
| Type | Proxy, Static, Redirect, or Respond |
| Target / Root | Upstream address (proxy) or root directory (static) |
| TLS | Whether Caddy's internal CA is used |
| Flags | Active optional features (compress, auth, access log, handle_path, …) |
| Actions | Edit, duplicate, and delete buttons |

## Server-tab route columns

| Column | Description |
|---|---|
| Matcher | Path, host, method, or other matchers — empty means catch-all |
| Label | Optional human-readable name |
| Type | Proxy, Static, Redirect, or Respond |
| Target | Upstream address or response details |
| Actions | Port/path link (opens URL), Edit, Duplicate, Delete |

## Search and filter

The search bar in the All tab filters entries in real time across port, target/root, label, and type.

## Adding entries

### Standalone entries

The toolbar has four **Add** buttons in the All tab:

- **Add Proxy** — reverse proxy to an upstream service
- **Add Static** — static file server from a directory
- **Add Redirect** — HTTP redirect rule
- **Add Respond** — static HTTP response

### Named servers

Click **Add Server** to create a named virtual server (owns a port, contains multiple routes). Once created, open the server's tab and use the Add buttons there to add routes.

See [Managing Entries](Managing-Proxies) for field details.

## Other tabs

| Tab | Description |
|---|---|
| **Logs** | Live Caddy log viewer with level filtering and search |
| **Caddyfile** | Raw Caddyfile editor with syntax validation |
| **Settings** | Global Caddy options (ports, debug mode, shutdown delays) and Internal CA viewer |

## Empty state

If no entries are configured, the list shows a prompt to add the first rule. This does not indicate a problem with Caddy — it simply means the Caddyfile has no managed blocks yet.
