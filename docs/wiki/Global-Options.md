# Global Options

The **Settings** tab configures Caddy's global options block (`/etc/caddy/Caddyfile`), applying to every proxy, server, and route rather than a single entry.

Settings are written and validated on **Save**, but — unlike adding or editing a proxy — **not reloaded automatically**. A "Caddyfile updated — reload Caddy to apply" banner appears after saving; click its **Reload config** button (or the toolbar's) to actually apply the change to the running service.

---

## Core options

| Field | Description |
|---|---|
| HTTP port / HTTPS port | Override Caddy's default `:80`/`:443` listen ports |
| Grace period / Shutdown delay | Connection-draining timing on reload/stop |
| Debug logging | Raises the global log level to `DEBUG` |

## ACME / Let's Encrypt

Registration email, ACME CA directory URL (with Let's Encrypt / staging / ZeroSSL presets), a custom trusted CA root, and External Account Binding (EAB) credentials for providers that require them (e.g. ZeroSSL).

ACME only applies to routes with a real public hostname — a bare `:443` with the internal CA doesn't use these settings at all. See the **ACME / Let's Encrypt** status modal (toolbar) for a live per-hostname view of which routes are actually using it.

## DNS challenge

The ACME DNS challenge (`acme_dns`) is the only way to get wildcard certificates, or certificates for hosts that aren't reachable on ports 80/443. It needs a Caddy build with a DNS provider module (`dns.providers.*`); distro packages usually have none, and the setting then says so and links the [module list](https://caddyserver.com/docs/modules/). The plugin doesn't install modules: replacing the packaged binary breaks package updates.

With a module installed, pick the provider and enter its credentials (option names are prefilled for Cloudflare, Hetzner, DuckDNS and deSEC). The values never go into the Caddyfile:

- they are written to `/etc/caddy/dns.env` (root:root, mode 600)
- a systemd drop-in, `/etc/systemd/system/caddy.service.d/cockpit-caddy-dns.conf`, loads that file into `caddy.service`
- the Caddyfile gets `acme_dns <provider> { <option> {env.CADDY_DNS_<OPTION>} }`

Caddy reads its environment only when it starts, so after a credential change the page asks for a **restart** (a reload isn't enough). A saved value shows as "Set" and is never displayed again. Turning the setting off removes the `acme_dns` block, the env file and the drop-in.

## On-demand TLS

On-demand TLS gets a site's certificate at the first TLS handshake instead of up front, for names that aren't known in advance. It is turned on **per site**: the site's HTTPS settings have an "On-demand" checkbox, written as `tls { on_demand }`.

This global section only configures it: the `ask` endpoint Caddy queries before it gets a certificate (it must answer 2xx to allow the name). Set one, or anyone who points a name at the server can make Caddy request certificates for it. The old `interval`/`burst` rate limits are no longer accepted by Caddy; the form only shows them while an existing config still has them, so they can be cleared.

## Internal TLS (hostless proxies)

Certificate lifetime and renewal window for proxies/servers using the internal CA **without a hostname**. Caddy only allows one shared policy for all hostless entries — proxies with a real hostname can set their own lifetime independently in their TLS Policy section instead.

## Storage

Where Caddy stores certificates and other TLS state (default: `/var/lib/caddy` under systemd). Shows effective path, disk usage, and managed certificate count. Changing this does not move existing certificates.

## Prometheus metrics

Exposes a `/metrics` endpoint with request-level metrics (requests, status codes, durations) across every proxy, plus Go runtime metrics. Requires a listen address since the admin API itself runs on a Unix socket.

## Runtime / error log

Caddy's own startup/reload/error log — separate from each proxy's own access log. Defaults to stderr (captured by `journalctl -u caddy`). Supports the same file output, rotation, format, and level options as a per-proxy access log.

## Trusted proxies

*(added in a later release)*

If Caddy sits behind another reverse proxy, load balancer, or CDN, it otherwise logs and matches on that intermediary's IP instead of the real client. Enable **Trust upstream proxy headers for the real client IP** and set which CIDR ranges are allowed to set that header — typically `private_ranges` (all private IPv4/IPv6 space) or your CDN's published IP list.

Only trust ranges you actually control the network path from — trusting an arbitrary/public range lets anyone spoof their client IP by sending the header themselves.

Applies globally, including to any port that also has its own HTTP/3 or timeout override.

## PROXY protocol

*(added in a later release)*

For a TCP-level load balancer that doesn't terminate TLS or add HTTP headers (e.g. AWS NLB, HAProxy in TCP mode) — Caddy reads the real client IP from the PROXY protocol preamble instead. This replaces the need for **Trusted proxies** above, which relies on an HTTP header a TCP-level LB can't add.

An optional allow-list restricts which source IPs may send a PROXY protocol header, and a timeout bounds how long Caddy waits for it.

**Once enabled, every connection must speak the PROXY protocol** — a normal browser or `curl` request without it will be rejected outright. Only enable this if the load balancer in front of Caddy is actually configured to send it.
