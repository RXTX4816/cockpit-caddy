# Manual Testing

A checklist for testing a release by hand on a [test VM](VM-Testing), with seed data so nothing has to be created first. It covers what changed since v0.9.0; add a section when a feature ships.

## Set up

```bash
npm run build
npm run vm start arch && npm run vm wait arch
npm run vm:seed            # or: npm run vm:seed debian
```

`vm:seed` (`scripts/seed-vm/`) writes the sites below with the plugin's own Caddyfile writers, installs them with snippets and global options, starts small demo backends and reloads Caddy. It backs up `/etc/caddy` to `/root/caddy-before-seed-<time>.tgz` first. The e2e fixtures reset the config, so seed again after an e2e run.

Open `https://localhost:9190`, log in as `test` / `test`, turn on administrative access and open **Caddy**.

The seeded ports are only reachable inside the VM. Run the `curl` checks there:

```bash
ssh -p 2230 -i .vms/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none test@localhost
```

Use `127.0.0.1`, not `localhost`: `localhost` resolves to `::1`, which isn't a trusted proxy.

## Seed data

| Port | Site | Shows |
|---|---|---|
| 443 | Two hostnames, automatic HTTPS | `app.example.test, www.example.test`, ACME |
| 8001 | Basic proxy (internal CA) | `tls internal`, compression, request/response headers, access log file |
| 8003 | Load balanced, sticky, health checks | 3 upstreams (9009 is dead), `lb_policy cookie seed_lb`, retries, passive and active health checks |
| 8004 | Basic auth | user `demo`, password `demo` |
| 8005 | Forward auth | `forward_auth` to a backend that allows everything |
| 8006 | Route matchers | path, method, header, query, exclude group, CEL expression |
| 8007 | Client IP behind trusted proxy | `client_ip 10.0.0.0/8`, trusted proxy `127.0.0.1/32` |
| 8008 | Static SPA | SPA fallback, index, hide `.git`, precompressed zstd br gzip |
| 8009 | Static file browser | `file_server browse` |
| 8010 | PHP app | `try_files`; no php-fpm on the VM, so requests get 502 |
| 8011 | Redirect | 302 to caddyserver.com |
| 8012 | Maintenance response | 503 "Down for maintenance" |
| 8013 | On-demand TLS | internal issuer with `on_demand` |
| 8014 | Snippet, error page, limits | `import security-headers`, 5xx error page, 1 MiB body limit, timeouts, strip prefix |
| 8020 | Named server "Internal tools" | `/grafana/*` → 9001, `/wiki/*` → 9002 |

Settings: email `admin@example.test`, trusted proxies `127.0.0.1/32`, on-demand ask URL. Snippets: `security-headers`, `cache-static`.

## Checklist

### Main screen

- [ ] **Calmer main screen (#259), phone layout (#258):** the list reads cleanly; at phone width it stays usable without sideways scrolling.
- [ ] **Config poll (#284):** on the VM, `sudo sed -i 's/Down for maintenance/Back soon/' /etc/caddy/conf.d/cockpit-caddy.conf && sudo systemctl reload caddy`. Within about 5 s the "Maintenance response" row shows the new text without a page reload.
- [ ] **Health checks (#252):** turn on **Health Monitor**. On "Load balanced…", 9001 and 9002 are up and 9009 is down.
- [ ] **Named server:** the "Internal tools :8020" tab has two routes. `curl -s 127.0.0.1:8020/grafana/` returns `Backend 9001`, `/wiki/` returns `Backend 9002`.

### Proxy dialog

- [ ] **Tabs (#260, #292, #291, #301):** open "Snippet, error page, limits". Tabs: General, Security, Routing, Upstreams, Logging & errors, Limits. The body size and server timeouts sit on **Limits**, each section has its own heading, and the Retry & Failover placeholders say whether they're a default or an example.
- [ ] **Several hostnames (#208), automatic HTTPS (#246):** "Two hostnames…" shows both names with **Automatic (ACME)**, and no lone Defaults button under it (#302). A new proxy with host `foo.example.test` defaults to ACME; a bare port defaults to the internal CA.
- [ ] **Per-site DNS challenge (#289):** in "Two hostnames…", **DNS challenge** reads "Inherit global (none set: HTTP challenge)". Override shows "No DNS provider module installed" (the VM's Caddy has none). Host `*.example.test` shows the wildcard warning. Don't save.
- [ ] **Load balancing (#285):** "Load balanced…" → Upstreams has policy **cookie**, name `seed_lb`. `header` and `weighted_round_robin` show their own fields. `curl -si 127.0.0.1:8003/ | grep -i set-cookie` shows `seed_lb=`.
- [ ] **Basic auth (#251):** `curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:8004/` → `401`; with `-u demo:demo` → `200`.
- [ ] **Forward auth (#248):** :8005 returns 200. Set the auth URI to `/nope` and save: 401 or 404.
- [ ] **Route matchers (#287, #250):** "Route matchers…" → Routing → Route Matchers shows every condition, the exclude group and the CEL expression. `curl -s -H 'X-Debug: 1' '127.0.0.1:8006/api/x?debug=1'` → `api ok (backend 9002)`; with `/api/private/x`, or without the header, the body is empty.
- [ ] **client_ip (#286):** `curl -s -H 'X-Forwarded-For: 10.1.2.3' 127.0.0.1:8007/` → `Backend 9001`; without the header the body is empty.
- [ ] **On-demand TLS (#253):** "On-demand TLS" has the on-demand box ticked. `curl -sk https://127.0.0.1:8013/` → `Backend 9001`.
- [ ] **Config correctness (#255, #254, #249):** save a site unchanged; the Caddyfile tab shows the same block. Timeout "Defaults" mean Caddy's own defaults.

### Static, PHP, redirect, respond

- [ ] **Tabbed dialogs (#293):** the four dialogs use the proxy dialog's tabs, with fewer of them.
- [ ] **SPA and file_server options (#262):** "Static SPA" shows SPA, index, hide `.git` and precompressed zstd, br, gzip. `curl -s 127.0.0.1:8008/any/deep/link` returns the SPA page; `/.git/config` → 404. Reorder precompressed, save, reopen: the order stays.
- [ ] **Static root (#245):** "Static file browser" reopens with `/srv/seed/files` and browse on.
- [ ] **PHP (#262, #247):** "PHP app" shows **Try files**; the Caddyfile pairs `php_fastcgi` with `file_server`.
- [ ] **Redirect, respond:** :8011 → 302 to caddyserver.com; :8012 → 503.

### Tools, Logs, Caddyfile, Settings

- [ ] **Internal CA (#315):** Tools → Internal CA shows Valid from, Valid until and the SHA-256 fingerprint.
- [ ] **ACME window (#282):** Tools → ACME lists `app.example.test` and `www.example.test` with status and the issuance error (`.test` names can't be issued).
- [ ] **Logs table (#257):** the Logs tab shows a table; a row opens its JSON; Raw switches back. More traffic: `for i in $(seq 20); do curl -sk https://127.0.0.1:8001/x$i >/dev/null; done`.
- [ ] **Highlighting (#283):** the Caddyfile tab and the editor colour directives and placeholders, including ones inside words (`https://caddyserver.com{uri}`).
- [ ] **Snippets (#288, #267):** Settings → Snippets lists `security-headers` and `cache-static`. Add `cache-static` to a site (General → snippet imports), save, reopen.
- [ ] **Error page:** `curl -s 127.0.0.1:8014/app/x` → "Upstream is down (502)".
- [ ] **Settings read back:** email, trusted proxies and the on-demand ask URL show the seeded values.
- [ ] **Global DNS challenge (#261):** Settings → DNS challenge shows "No DNS provider module installed" with the modules link.
- [ ] **Metrics:** enable with listen `:9180`, path `/metrics`, save. `curl -s 127.0.0.1:9180/metrics | head` shows metrics.
- [ ] **Translations (#244):** switch Cockpit's display language and spot-check a few dialogs.
- [ ] **Stock Caddyfile migration (#256), last, it replaces the seed:** `printf ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n' | sudo tee /etc/caddy/Caddyfile && sudo systemctl reload caddy`. Add a proxy: it saves without a prompt, and the old site shows up with an English label. Run `npm run vm:seed` afterwards.

### Not covered by the VM

- **Container logs on rootless Docker (#191):** the VM has no Docker.
- **DNS credentials (#261, #289, #316):** saving credentials, the per-site override and the rollback after a failed save need a Caddy build with a DNS provider module. The unit tests cover them, and `src/api/siteDns.test.ts` runs its `caddy adapt` checks when the `caddy` on `PATH` has one.
