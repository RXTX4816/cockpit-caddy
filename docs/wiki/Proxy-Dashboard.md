# Proxy Dashboard

The Proxy Dashboard is the main screen of the Cockpit Caddy plugin. It lists all entries currently configured in Caddy and shows the service status at a glance.

## Layout

The page is divided into three areas:

1. **Header** — the Caddy service status and its actions (see [Service Control](Service-Control)), the **Tools** menu (Internal CA, ACME / Let's Encrypt, config check, backup and restore) and the gear icon for the Admin API address.
2. **Tab bar** — Proxy List, Caddyfile, Logs and Settings.
3. **Entry list** — entries grouped by server tabs (see below), with **Add Proxy**, **Add Server**, search, the **Health Monitor** switch and a refresh button above it.

The list re-reads Caddy's config every 5 seconds and right after every change, so edits made outside the plugin (a hand-edited Caddyfile, `caddy reload`) show up without reloading the page. At phone width the header, toolbar and list rearrange to fit the screen without sideways scrolling.

## Server tabs

The entry list is split into tabs:

| Tab | What it shows |
|---|---|
| **All** | Every entry across all servers and standalone rules |
| **Ungrouped** | Standalone entries only (those that aren't routes of a named server) |
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
| **PHP** | Runs a PHP app through PHP-FPM (`php_fastcgi` + `file_server`) |

## All-tab columns

| Column | Description |
|---|---|
| Label | Optional human-readable name for the rule |
| Type | Proxy, Static, PHP, Redirect, or Respond |
| Address | The site address (port, or hostnames and port) — click to open it in a new tab. Badges after it show where the certificate comes from (ACME, Internal CA, custom) and the active options (Compress, Logging, LB, Auth, Forward Auth, matcher, browse, redirect code, …) |
| Target | Upstream addresses (proxy), root directory (static), FastCGI upstream (PHP), redirect target or response |
| Actions | Edit (pencil) and a menu with Duplicate and Delete |

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

## Health Monitor

The **Health Monitor** switch (after a confirmation) probes each proxy's upstream from the server every 5 seconds and shows a dot: **Reachable** for any HTTP answer, even 4xx/5xx, **Unreachable** for a refused connection or a timeout. Probing stops when you turn the switch off. This is the plugin's own check; Caddy's health checks, which take upstreams out of rotation, are set per site under Retry & Failover (see [Managing Entries](Managing-Proxies)).

## Adding entries

### Standalone entries

**Add Proxy** adds a reverse proxy. The arrow next to it (**More site types**) offers the other kinds:

- **Reverse proxy** — forward to an upstream service
- **Static files** — serve a directory
- **PHP site** — a PHP app behind PHP-FPM
- **Redirect** — HTTP redirect rule
- **Fixed response** — a static HTTP response

### Named servers

Click **Add Server** to create a named virtual server (owns a port, contains multiple routes). Once created, open the server's tab and use the Add buttons there to add routes.

See [Managing Entries](Managing-Proxies) for field details.

## Other tabs

| Tab | Description |
|---|---|
| **Logs** | Caddy's log lines as a table (Time, Level, Logger, Host, Request, Status, Message). Filter by level and logger, search, and click a row to see its full JSON. **Raw** switches to the plain lines. Admin API requests are hidden unless **Show admin API requests** is on |
| **Caddyfile** | Raw Caddyfile viewer and editor with syntax highlighting (addresses, directives, matchers, placeholders, strings, heredocs, comments; `{ }` blocks fold) and validation before saving |
| **Settings** | Global Caddy options (ports, ACME, DNS challenge, on-demand TLS, storage, metrics, trusted proxies, …) and Snippets. See [Global Options](Global-Options) |

## Empty state

If no entries are configured, the list shows a prompt to add the first rule. This does not indicate a problem with Caddy — it simply means the Caddyfile has no managed blocks yet.

## Fresh install: the distro's Caddyfile

The Caddyfile a distro package ships (Arch, Debian/Ubuntu, Fedora) only holds a welcome page on port 80. The plugin recognises it by its structure and shows no migration warning for it. The first change you save moves the welcome site into conf.d as a static site labelled **Distro welcome page**, which you can edit or delete like any other. A Caddyfile with your own sites still shows the warning: its sites move to conf.d when you click **Migrate**, and **Details** shows the paths involved.

## ACME / Let's Encrypt window

**Tools → ACME / Let's Encrypt** lists each hostname with its issuer and a certificate status: *valid until* (and when Caddy renews it, at a third of the lifetime left), *renewal due*, *obtaining…*, *failed* with Caddy's error message, or *no certificate*. The status comes from the certificates in Caddy's storage and the `tls` entries of Caddy's log. Click a hostname to see its certificate: subject, names, issuer, validity, SHA-256 fingerprint and the PEM to copy or download. The private key is never read.

## Internal CA window

**Tools → Internal CA** shows Caddy's local certificate authority: the root and intermediate certificate names, the root's **Valid from** / **Valid until** dates and SHA-256 fingerprint, buttons to copy or download each PEM, and how to install the root in browsers and operating systems. When no site uses the internal CA, a notice says so: visitors then get certificates from ACME or your own files instead.
