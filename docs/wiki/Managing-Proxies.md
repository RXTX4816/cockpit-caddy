# Managing Entries

Entries can be added, edited, duplicated, and deleted from the [Proxy Dashboard](Proxy-Dashboard) without touching the Caddyfile directly.

---

## Reverse Proxy

Click **Add Proxy** in the toolbar.

### Required fields

| Field | Description |
|---|---|
| External Address | Port (and optionally scheme + hostname) Caddy listens on |
| Target Host | Upstream host to forward traffic to (default `localhost`) |
| Target Port | Upstream port |

### Common optional fields

| Field | Description |
|---|---|
| Label | Human-readable name (e.g. `Nextcloud`) |
| TLS | Enable self-signed TLS via Caddy's internal CA (on by default) |
| Compression | Enable gzip/zstd response compression |
| Skip TLS verify | Skip verification of the upstream's TLS certificate (for self-signed backends) |

### Optional sections

Each proxy dialog has expandable sections for advanced configuration. Every section has a **Clear** button (with confirm) that resets it, and sections with known defaults also have a **Defaults** button.

| Section | What it configures |
|---|---|
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

Same expandable sections as the proxy dialog except Transport, Rewrite, Forward Auth, and Extra Upstreams (which don't apply to a file server): Access Log, Error Handlers, Server Timeouts, Basic Auth, Request Headers, and Response Headers.

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

---

## Editing an entry

Click **Edit** on any row. The same dialog opens pre-filled with current values. All optional sections retain their existing configuration.

## Duplicating an entry

Click **Duplicate** on any row. The Add dialog opens pre-filled with all values from the source entry (port field left blank so it doesn't conflict). All optional sections are copied.

## Deleting an entry

Click **Delete** on any row. A confirmation dialog appears before the entry is removed. Caddy reloads automatically after deletion.

---

## How entries map to the Caddyfile

Each entry corresponds to a server block. For example, a reverse proxy on port 8443:

```
:8443 {
    tls internal
    encode gzip zstd
    reverse_proxy localhost:8080
}
```

The plugin reads and writes these blocks. You can also edit the Caddyfile directly via the **Caddyfile** tab — the UI picks up any external changes after a Caddy reload.
