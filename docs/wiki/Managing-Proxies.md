# Managing Proxies

Proxy rules can be added, edited, and deleted from the [Proxy Dashboard](Proxy-Dashboard) without touching the Caddyfile directly.

---

## Adding a proxy rule

Click **Add Proxy** in the toolbar. A dialog opens with the following fields:

| Field | Required | Description |
|---|---|---|
| Label | No | A human-readable name for this rule (e.g. `Nextcloud`) |
| HTTPS Port | Yes | The local port Caddy will listen on over HTTPS (e.g. `8443`) |
| Target Host | Yes | The upstream host to forward traffic to (e.g. `localhost`) |
| Target Port | Yes | The upstream port (e.g. `8080`) |
| TLS (internal) | — | Checkbox — enabled by default; uses Caddy's internal CA |

Click **Save** to apply. Caddy reloads automatically — no restart required.

**Port range:** Use any unprivileged port (1024–65535) not already in use. Common choices start at `8443` and increment (`8444`, `8445`, …).

**TLS internal:** Leave this enabled unless you have a specific reason not to. Caddy's internal CA issues self-signed certificates trusted by Caddy's own trust store. You will need to trust the CA in your browser the first time — see [Troubleshooting](Troubleshooting).

---

## Editing a proxy rule

Click the **Edit** button (pencil icon) on any proxy row. The same dialog opens pre-filled with the current values. Modify any field and click **Save**.

Changing the HTTPS port effectively replaces the rule — the old port stops listening and the new one starts.

---

## Deleting a proxy rule

Click the **Delete** button (trash icon) on any proxy row. A confirmation dialog appears before the rule is removed.

After deletion, Caddy reloads automatically. The port is freed immediately.

---

## How rules map to the Caddyfile

Each proxy rule corresponds to a server block in the Caddyfile:

```
:8443 {
    tls internal
    reverse_proxy localhost:8080
}
```

The plugin reads and writes these blocks via the Caddy Admin API (`localhost:2019`). You can also edit the Caddyfile directly — changes made outside the UI are picked up after a Caddy reload.
