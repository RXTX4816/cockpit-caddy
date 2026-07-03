# Managing Entries

Entries can be added, edited, duplicated, and deleted from the [Proxy Dashboard](Proxy-Dashboard) without touching the Caddyfile directly.

---

## Named Servers

A **named server** is a virtual host that owns a listen port and contains multiple routes. Routes inside a server share the port and use **route matchers** to decide which route handles each request.

Use named servers when you want to serve multiple services on a single port — for example, routing `/api/*` to a backend and everything else to a frontend, all on `:443`.

### Creating a server

Click **Add Server** in the toolbar.

| Field | Description |
|---|---|
| Display Name | Human-readable label for the server tab (e.g. `Public HTTPS`) |
| Listen Ports | One or more ports this server listens on (e.g. `:443`) |
| TLS | Enable TLS for the whole server via Caddy's internal CA |

The server gets a unique key (slug) derived from its name. Once created it appears as its own tab in the proxy list.

### Adding routes to a server

Open the server's tab and use the **Add Proxy / Add Redirect / Add Static / Add Respond** buttons. Routes added here belong to the server — they do not have their own port.

### Server detail panel

Each server tab shows:
- A **server info card** with listen addresses (clickable `↗` links), TLS state, and timeouts.
- A **routes table** with one row per route. Each row has a clickable `:<port>[/path]` link that opens the route's external URL directly.

### Editing and deleting a server

Use the **Edit Server** and **Delete Server** buttons in the server info card. Deleting a server removes it and all its routes.

---

## Route Matchers

Route matchers restrict which requests a route handles. They are available in all Add/Edit dialogs via the expandable **Route Matchers** section.

When a route has no matchers, it is a **catch-all** — it handles any request that was not matched by an earlier route.

When multiple matchers are set (e.g. path + host), they are combined with AND logic (all must match).

| Matcher type | Example | Notes |
|---|---|---|
| **Path** | `/api/*` | Glob patterns. `*` matches a single segment; `**` or `/*` matches any suffix |
| **Host** | `example.com` | Exact hostname match |
| **Method** | `POST`, `PUT` | One or more HTTP methods |
| **Header** | `X-Auth: Bearer*` | Header name + optional value pattern; leave value blank to match header presence |
| **Query param** | `debug=true` | URL query parameter name + optional value |
| **Remote IP / CIDR** | `10.0.0.0/8` | Source IP range |

### Strip matched path prefix (handle_path)

When only a **path** matcher is set, a "Strip matched path prefix" checkbox appears. Enabling it uses Caddy's `handle_path` directive:

- The external URL includes the path prefix: `https://host:443/api/orders`
- Caddy strips the prefix before forwarding: the upstream receives `/orders`

Without strip, the upstream receives the full path `/api/orders`.

---

## Reverse Proxy

Click **Add Proxy** in the toolbar.

### Required fields

| Field | Description |
|---|---|
| External Address | Port (and optionally scheme + hostname) Caddy listens on — omitted when adding to a named server |
| Target Host | Upstream host to forward traffic to (default `localhost`) |
| Target Port | Upstream port |

### Common optional fields

| Field | Description |
|---|---|
| Label | Human-readable name (e.g. `Nextcloud`) |
| TLS | Enable self-signed TLS via Caddy's internal CA (on by default) — server-level when inside a named server |
| Compression | Enable gzip/zstd response compression |
| Skip TLS verify | Skip verification of the upstream's TLS certificate (for self-signed backends) |

### Optional sections

Each proxy dialog has expandable sections for advanced configuration. Every section has a **Clear** button (with confirm) that resets it, and sections with known defaults also have a **Defaults** button.

| Section | What it configures |
|---|---|
| **Route Matchers** | Path, host, method, header, query, and remote IP matchers |
| **Transport** | Dial timeout, response header timeout |
| **Access Log** | Per-server access logging (output, format, level) |
| **Error Handlers** | Custom responses for 4xx/5xx errors |
| **Forward Auth** | Delegate authentication to an external service |
| **Server Timeouts** | Read, write, idle timeouts and max header size |
| **Basic Auth** | Username/password protection |
| **Rewrite** | Strip prefix, add prefix, or regex path rewrite |
| **Request Headers** | Add, set, or delete upstream request headers |
| **Response Headers** | Add, set, or delete downstream response headers |
| **Extra Upstreams** | Additional upstream targets with load-balancing policy |

---

## Static File Server

Click **Add Static** in the toolbar.

### Required fields

| Field | Description |
|---|---|
| Port | External port Caddy listens on |
| Root Directory | Path on disk to serve files from (e.g. `/var/www/html`) |

### Optional fields

| Field | Description |
|---|---|
| Label | Human-readable name |
| Browse | Enable directory listing |
| TLS | Self-signed TLS via Caddy's internal CA (on by default) |
| Compression | Enable gzip/zstd compression |

### Optional sections

Same expandable sections as the proxy dialog except Transport, Rewrite, Forward Auth, and Extra Upstreams (which don't apply to a file server): Route Matchers, Access Log, Error Handlers, Server Timeouts, Basic Auth, Request Headers, and Response Headers.

---

## Redirect

Click **Add Redirect** in the toolbar.

| Field | Description |
|---|---|
| Port | External port Caddy listens on |
| Redirect To | Target URL (e.g. `https://example.com`) |
| Status Code | HTTP redirect code (301, 302, 307, 308) |
| Label | Optional name |
| TLS | Self-signed TLS (on by default) |

Route Matchers are also available for redirects inside a named server.

---

## Static Response

Click **Add Respond** in the toolbar. Returns a fixed HTTP response — useful for maintenance pages or health-check endpoints.

| Field | Description |
|---|---|
| Port | External port Caddy listens on |
| Status Code | HTTP status (100–599, default 200) |
| Response Body | Optional plain-text or HTML body |
| Close Connection | Close the connection after the response |
| Label | Optional name |
| TLS | Self-signed TLS (on by default) |

Route Matchers are also available for respond entries inside a named server.

---

## Editing an entry

Click **Edit** on any row. The same dialog opens pre-filled with current values. All optional sections retain their existing configuration.

## Duplicating an entry

Click **Duplicate** on any row. The Add dialog opens pre-filled with all values from the source entry (port field left blank so it doesn't conflict). All optional sections are copied. If the source route belongs to a named server, the duplicate is added to the same server.

## Deleting an entry

Click **Delete** on any row. A confirmation dialog appears before the entry is removed. Caddy reloads automatically after deletion.

---

## How entries map to the Caddyfile

**Standalone entry** — each entry is its own server block:

```caddyfile
:8443 {
    tls internal
    encode gzip zstd
    reverse_proxy localhost:8080
}
```

**Named server with multiple routes** — one block, routes use matchers:

```caddyfile
# server: public-https
# serverdef: {"name":"Public HTTPS","tls":true}
:443 {
    tls internal
    @r0 path /api/*
    handle @r0 {
        reverse_proxy localhost:3000
    }
    handle {
        reverse_proxy localhost:4000
    }
}
```

**Strip prefix (handle_path)**:

```caddyfile
handle_path /api/* {
    reverse_proxy localhost:3000
}
```

The plugin reads and writes these blocks surgically — editing one route never affects other routes in the same server. You can also edit the Caddyfile directly via the **Caddyfile** tab — the UI picks up any external changes after a Caddy reload.
