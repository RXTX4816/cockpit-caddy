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
| TLS | Where the certificate comes from: ACME (automatic HTTPS), Internal CA, Custom cert, or none |
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
| **Caddyfile** | Raw Caddyfile viewer and editor with syntax highlighting (addresses, directives, matchers, placeholders, strings, heredocs, comments; `{ }` blocks fold) and validation before saving |
| **Settings** | Global Caddy options (ports, debug mode, shutdown delays) and Internal CA viewer |

## Empty state

If no entries are configured, the list shows a prompt to add the first rule. This does not indicate a problem with Caddy — it simply means the Caddyfile has no managed blocks yet.

## Fresh install: the distro's Caddyfile

The Caddyfile a distro package ships (Arch, Debian/Ubuntu, Fedora) only holds a welcome page on port 80. The plugin recognises it by its structure and shows no migration warning for it. The first change you save moves the welcome site into conf.d as a static site labelled **Distro welcome page**, which you can edit or delete like any other. A Caddyfile with your own sites still shows the warning: its sites move to conf.d when you click **Migrate**, and **Details** shows the paths involved.

## ACME / Let's Encrypt window

**Tools → ACME / Let's Encrypt** lists each hostname with its issuer and a certificate status: *valid until* (and when Caddy renews it, at a third of the lifetime left), *renewal due*, *obtaining…*, *failed* with Caddy's error message, or *no certificate*. The status comes from the certificates in Caddy's storage and the `tls` entries of Caddy's log. Click a hostname to see its certificate: subject, names, issuer, validity, SHA-256 fingerprint and the PEM to copy or download. The private key is never read.
