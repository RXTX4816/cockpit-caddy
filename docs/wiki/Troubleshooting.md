# Troubleshooting

Common problems and how to fix them.

---

## Plugin doesn't appear in Cockpit

**Symptom:** You open Cockpit but there is no "Caddy Proxy" entry in the left navigation.

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

## Caddy Admin API not reachable

**Symptom:** The dashboard loads but shows an error connecting to Caddy, or the proxy list is empty with no "Add Proxy" option.

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
