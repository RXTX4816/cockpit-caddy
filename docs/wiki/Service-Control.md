# Service Control

The Service Control bar at the top of the [Proxy Dashboard](Proxy-Dashboard) shows the current state of the Caddy systemd service and lets you manage it without leaving the browser.

## Status badge

| Badge | Meaning |
|---|---|
| **Running** (green) | `caddy.service` is active and the Admin API is reachable |
| **Stopped** (grey) | `caddy.service` is inactive |
| **Error** (red) | Service failed or Admin API is unreachable |

The badge refreshes automatically every few seconds.

## External mode

If Caddy's Admin API is reachable but there's no *local, actively-running* `caddy.service` behind it — for example, Caddy is running in a Docker container, or some other process on the host is answering on the same port/socket — the plugin shows a blue **External** badge instead of the usual Start/Stop/Restart/Reload state.

In this mode:

- **Start / Stop / Restart are disabled.** There's no local systemd unit to safely control, and starting one anyway can actively conflict with whatever is really serving requests (e.g. two Caddy processes fighting over the same port).
- **Reload still works**, via the Admin API instead of `systemctl reload` — it pushes the current on-disk Caddyfile (with `conf.d/*.conf` files inlined) straight to the running instance.
- Proxy management, the Caddyfile editor, and the config health check all work normally, since they only need the Admin API to be reachable.
- The **Logs** tab needs a bit of extra setup — see [below](#viewing-logs-in-external-mode).

See [Managing a containerized Caddy](Troubleshooting#managing-a-containerized-caddy) in Troubleshooting for a worked example.

### Viewing logs in external mode

`journalctl -u caddy` has nothing to show for a process with no local systemd unit, so the Logs tab instead reads `docker logs <container>` for a container name you configure. Open the Admin API Address dialog (gear icon next to Service Control) and fill in **Container name (for logs)** with the name or ID of the container running Caddy, then use **Test container** to confirm it's reachable. Until a container name is set, the Logs tab shows a prompt instead of silently staying empty.

### "Caddy service failed" alert

If the local `caddy.service` unit is genuinely `failed` (not just inactive) **and** the Admin API isn't reachable through any other means either, the plugin shows a red alert with the actual `systemctl status caddy` output (in a collapsible details section) so you can see why it crashed — e.g. a port conflict — without leaving the browser. This alert stays quiet whenever the Admin API is reachable through something else, since in that case Caddy is working fine regardless of the local unit's state.

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
