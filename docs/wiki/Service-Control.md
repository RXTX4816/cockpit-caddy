# Service Control

The Service Control bar at the top of the [Proxy Dashboard](Proxy-Dashboard) shows the current state of the Caddy systemd service and lets you manage it without leaving the browser.

## Status badge

| Badge | Meaning |
|---|---|
| **Running** (green) | `caddy.service` is active and the Admin API is reachable |
| **Stopped** (grey) | `caddy.service` is inactive |
| **Error** (red) | Service failed or Admin API is unreachable |

The badge refreshes automatically every few seconds.

---

## Actions

### Start

Runs `systemctl start caddy`. Use this when Caddy is stopped and you want to bring it up without rebooting.

### Stop

Runs `systemctl stop caddy`. Stops Caddy and all active proxy listeners. Existing connections are terminated.

### Restart

Runs `systemctl restart caddy`. Stops and starts Caddy. Use this when Caddy is in an error state or after manual Caddyfile edits that require a full restart.

### Reload

Runs `systemctl reload caddy` (equivalent to `caddy reload`). Applies configuration changes without dropping existing connections. **Prefer Reload over Restart** for routine changes — it is faster and has zero downtime.

The plugin uses Reload automatically when you add, edit, or delete an entry.

---

## Enabling Caddy at boot

The service control panel manages the running state only. To enable Caddy to start automatically at boot, run once on the server:

```bash
sudo systemctl enable caddy
```

---

## Checking Caddy logs

If the service shows an error, inspect the journal for details:

```bash
journalctl -u caddy -n 50
```

See [Troubleshooting](Troubleshooting) for common error causes and fixes.
