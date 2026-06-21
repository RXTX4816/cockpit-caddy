# Proxy Dashboard

The Proxy Dashboard is the main screen of the Cockpit Caddy plugin. It lists all reverse proxy rules currently configured in Caddy and shows the Caddy service status at a glance.

## Layout

The page is divided into two areas:

1. **Service Control bar** — shows the Caddy service status (running/stopped) and action buttons (Start, Stop, Restart, Reload). See [Service Control](Service-Control).
2. **Proxy list** — a table of all configured reverse proxy rules.

## Proxy list columns

| Column | Description |
|---|---|
| Label | Optional human-readable name for the rule |
| HTTPS Port | The local HTTPS port Caddy listens on (e.g. `8443`) |
| Target | The upstream address traffic is forwarded to (e.g. `localhost:8080`) |
| TLS | Whether Caddy's internal CA is used for this rule |
| Actions | Edit and delete buttons for this rule |

Each row represents one `reverse_proxy` block in the Caddyfile. Caddy handles TLS termination automatically — the browser connects to the HTTPS port, and Caddy forwards plain HTTP to the target.

## Search and filter

The search bar above the proxy list filters rows in real time. You can search by:

- **Port** — e.g. `8443`
- **Target** — e.g. `localhost` or `10.0.0`
- **Label** — any part of the rule's name

The filter is case-insensitive and matches across all three fields simultaneously.

## Adding a proxy

Click **Add Proxy** in the toolbar to open the [Add Proxy dialog](Managing-Proxies).

## Empty state

If no proxy rules are configured, the list shows a prompt to add the first rule. This does not indicate a problem with Caddy — it simply means the Caddyfile has no reverse proxy blocks yet.
