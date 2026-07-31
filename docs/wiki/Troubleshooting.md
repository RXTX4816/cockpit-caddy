# Troubleshooting

Common problems and how to fix them.

---

## Plugin doesn't appear in Cockpit

**Symptom:** You open Cockpit but there is no "Caddy" entry in the left navigation.

**Causes and fixes:**

1. **Package not installed in the right location.** The plugin files must be at `/usr/share/cockpit/cockpit-caddy/`. Verify:
   ```bash
   ls /usr/share/cockpit/cockpit-caddy/
   ```
   If empty or missing, reinstall the package or re-run the manual install steps.

2. **Cockpit cache.** Hard-refresh the browser (`Ctrl+Shift+R` / `Cmd+Shift+R`) or clear site data and reload.

3. **Development symlink missing.** In dev mode, the symlink must point to the `src/` directory, not the repo root:
   ```bash
   ls -la ~/.local/share/cockpit/cockpit-caddy
   # Should point to .../cockpit-caddy/src
   ```

---

## Managing a containerized Caddy

Cockpit Caddy doesn't require Caddy to be installed as a local systemd service — if the Admin API is reachable (TCP and/or a Unix socket), the plugin works against it directly. This covers running Caddy in Docker, or any setup where the process managing Caddy isn't `caddy.service`. See [External mode](Service-Control#external-mode) for what changes in the UI.

**Requirements for this to work well:**

- The container needs its Admin API reachable from the host — either publish the TCP port, or bind-mount a Unix socket directory (e.g. `/run/caddy`) between host and container. Configure the address(es) to try via the gear icon (Admin API Address dialog).
- For proxy management, the Caddyfile editor, and backup/restore to reflect the *real* running config, the container must bind-mount the same `/etc/caddy` directory the plugin edits on the host. If the container has its own separate, non-shared config, those features will show/edit files the container never actually reads.
- `network_mode: host` is the simplest way to satisfy both of the above if your Caddyfile binds the Admin API to `localhost` (a loopback bind is only reachable from the host if the container shares the host's network namespace).

Example `docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2.11.4
    network_mode: host
    volumes:
      - /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - /run/caddy:/run/caddy
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```

**Running a native `caddy.service` at the same time:** don't. If both a local systemd-managed Caddy and a container are configured to use the same Admin API port/socket, whichever one loses the race crashes (`bind: address already in use`), and — because systemd's `RuntimeDirectory=` recreates `/run/caddy` fresh on every restart attempt — a crash-looping local service can keep invalidating the container's bind-mounted socket directory out from under it, breaking the container's config reloads too. If you only installed the native package to test something, stop and disable it:

```bash
sudo systemctl stop caddy
sudo systemctl disable caddy
```

then restart the container so it re-creates its listeners cleanly.

---

## Caddy Admin API not reachable

**Symptom:** The dashboard loads but shows an error connecting to Caddy, or the entry list is empty with no add buttons.

**Fix:** Verify the Admin API is running:

```bash
curl http://localhost:2019/config/
```

If this fails, check Caddy's status:

```bash
systemctl status caddy
journalctl -u caddy -n 30
```

The Admin API is enabled by default. If you have a custom Caddyfile that disables it, re-enable it:

```
{
    admin localhost:2019
}
```

---

## TLS certificate not trusted in browser

**Symptom:** After adding a proxy rule, your browser shows a certificate warning when visiting `https://your-server:8443`.

**Cause:** Caddy uses its own internal CA (`tls internal`). The CA root certificate is not trusted by your browser by default.

**Fix (one-time):** Export the Caddy CA root certificate and import it into your browser or OS trust store.

Caddy stores its CA at:
```
/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

Or fetch it programmatically:
```bash
curl -s http://localhost:2019/pki/ca/local | jq -r '.root_certificate'
```

In Firefox: **Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import**

In Chrome/Chromium: **Settings → Privacy and security → Security → Manage certificates → Authorities → Import**

On Arch/Fedora/Debian system-wide:
```bash
sudo trust anchor --store /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

---

## Caddy service fails to start

**Symptom:** Clicking **Start** in the service control bar results in an error, or the status immediately returns to **Stopped**.

**Fix:** Check the journal for the specific error:

```bash
journalctl -u caddy -n 50
```

Common causes:

- **Port already in use.** Another process is listening on a port Caddy is trying to bind. Find it with `ss -tlnp | grep <port>`.
- **Caddyfile syntax error.** Validate the config before starting: `caddy validate --config /etc/caddy/Caddyfile`.
- **Permissions issue.** Caddy must be able to read its Caddyfile and write to its data directory. Check ownership of `/etc/caddy/` and `/var/lib/caddy/`.

---

## Changes not reflected after editing

**Symptom:** You add or edit a proxy rule but the change doesn't seem to take effect.

**Fix:** The plugin triggers a Caddy reload after each change. If the reload failed silently, use **Reload** manually from the service control bar, or run:

```bash
sudo systemctl reload caddy
```

Then verify the config was applied:

```bash
curl http://localhost:2019/config/
```
