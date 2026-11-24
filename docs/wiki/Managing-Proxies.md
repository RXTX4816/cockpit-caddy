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
| HTTPS | On (default): HTTPS for the whole server with Caddy's internal CA. A named server only listens on ports, so it can't get an automatic (ACME) certificate. Off: plain HTTP |

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

Route matchers restrict which requests a route handles. They are available in all Add/Edit dialogs: on the **Routing** tab of the proxy dialogs, and as the expandable **Route Matchers** section in the others.

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
| External Address | Port (and optionally scheme + hostname) Caddy listens on — omitted when adding to a named server. Several hostnames can share one proxy: separate them with commas (`example.com, www.example.com`) and they are written as one site block with every name |
| Target Host | Upstream host to forward traffic to (default `localhost`) |
| Target Port | Upstream port |

### Common optional fields

| Field | Description |
|---|---|
| Label | Human-readable name (e.g. `Nextcloud`) |
| HTTPS certificate | **Automatic (Let's Encrypt / ACME)** — the default for a public hostname: Caddy gets and renews a public certificate, no `tls` line is written. **Caddy's internal CA** — the default for a bare port, an IP or a local name (`tls internal`); browsers trust it only where the CA's root is installed. **Off** — plain HTTP. A certificate file under TLS settings overrides the issuer. Inside a named server, TLS is set on the server. |
| Compression | Enable gzip/zstd response compression |
| Skip TLS verify | Skip verification of the upstream's TLS certificate (for self-signed backends) |

### Tabs

The Add and Edit Proxy dialogs split their settings into five tabs. A tab shows a small dot once something in it differs from the defaults, and an error icon when it holds an invalid value; **Add** / **Save** jumps to the first tab with an error. Inside a tab every section is shown open, there are no Clear / Defaults buttons, and a field that falls back to a Caddy default gets a **Reset to Caddy default** button (↶) once it holds a value. Empty fields show the default greyed out ("Default: 5m") or an example ("e.g. 8080").

Sizes (max request body size, max header size) are entered as a number and a unit (bytes, KB, MB, GB) and stored in bytes.

| Tab | Sections |
|---|---|
| **General** | Label, external address (`[protocol ▾] [host] : [port]`), target (`http` / `https` toggle, host, port), HTTPS certificate, snippet imports |
| **Security** | HTTP Basic Auth, Forward Authentication, TLS Policy |
| **Routing** | Route Matchers, URI Rewrite, Request Headers, Response Headers, named route (`invoke`) |
| **Upstreams** | Additional Upstreams and load-balancing policy, Retry & Failover Tuning (including health checks), Upstream Timeouts |
| **Logging & errors** | Access logging, Custom error handlers, Server Timeouts & Limits, Max request body size |

The static, redirect, respond and PHP dialogs keep the older layout: expandable sections, one open at a time, each with a **Clear** button (with confirm) and, where Caddy has defaults, a **Defaults** button that empties the fields.

| Section | What it configures |
|---|---|
| **TLS Policy** | Protocol versions, cipher suites, curves, mTLS, internal-issuer certificate lifetime — or a custom/bring-your-own certificate (point at existing cert + key PEM files instead of Caddy issuing one) |
| **Access Log** | Per-server access logging (output, format, level, rotation) |
| **Error Handlers** | Custom responses for 4xx/5xx errors |
| **Forward Auth** | Delegate authentication to an external service |
| **Upstream Timeouts** | Dial timeout, response header timeout |
| **Server Timeouts** | Read, write, idle timeouts, max header size, and HTTP/3 opt-out |
| **Basic Auth** | Username/password protection |
| **Rewrite** | Strip prefix, add prefix, or regex path rewrite |
| **Request Headers** | Add, set, or delete upstream request headers |
| **Response Headers** | Add, set, or delete downstream response headers |
| **Extra Upstreams** | Additional upstream targets with a load-balancing policy |
| **Retry & Failover Tuning** | Max retries, retry duration/interval, and which upstream response codes count as a failure worth retrying — applies even with a single upstream |
| **Route Matchers** | Path, host, method, header, query, and remote IP matchers |

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
| HTTPS certificate | Caddy's internal CA (default) or Off; a site with a public hostname can also use Automatic (Let's Encrypt / ACME) |
| Compression | Enable gzip/zstd compression |

### Optional sections

Same as the proxy dialog except Transport, Rewrite, Forward Auth, Extra Upstreams, and Retry & Failover Tuning (which don't apply to a file server, since there's no upstream to dial): TLS Policy (including custom certificates), Access Log, Error Handlers, Server Timeouts, Basic Auth, Request Headers, Response Headers, and Route Matchers. The Max request body size field is also available in the main form.

---

## Redirect

Click **Add Redirect** in the toolbar.

| Field | Description |
|---|---|
| Port | External port Caddy listens on |
| Redirect To | Target URL (e.g. `https://example.com`) |
| Status Code | HTTP redirect code (301, 302, 307, 308) |
| Label | Optional name |
| TLS | Caddy's internal CA (on by default) |

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
| TLS | Caddy's internal CA (on by default) |

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
