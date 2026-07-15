# E2E Test Coverage

A catalog of every Playwright end-to-end spec in `e2e/`: what it exercises, and how.
Use this page to see what's already covered before adding new tests, and to spot gaps.

**Current totals:** 39 spec files, 139 tests, run against real Cockpit + Caddy on QEMU
VMs (see [VM Testing](VM-Testing)). All specs share one Caddy instance per VM
(`workers: 1` in `playwright.config.ts`), so they run serially and each test resets
config state via the `pluginPage` fixture before it starts.

## Testing philosophy

Every test in this suite exercises a **real state change** and verifies it round-tripped
through Caddy correctly — never a bare "is this element visible" check. The two-part
pattern used throughout:

1. **UI action** — drive the actual dialog/form via Playwright locators (never bypass the
   UI for the thing under test; helper functions like `addProxy()` in `e2e/helpers.ts`
   exist only to seed *unrelated* pre-existing state quickly).
2. **Verification** — assert on the resulting Caddyfile/conf.d text (`readConf()`,
   `readFile()`) **and**, wherever the feature affects live traffic, a real `curl`/`openssl`
   request against the actual running Caddy process (`e2e/live.ts`: `curlStatus()`,
   `waitForListener()`, `expectCaddyActive()`).

Helper reference (`e2e/helpers.ts`, `e2e/live.ts`, `e2e/fixtures.ts`):

| Helper | Purpose |
|---|---|
| `resetConfig()` | Wipes managed config to a clean slate — runs automatically before every test |
| `addProxy/addRedirect/addStatic/addRespond/addServer()` | Seed a route directly into conf.d (bypasses the UI) when a test needs *pre-existing* state unrelated to what it's testing |
| `baseData()` | One already-working proxy + live backend — the common starting point for tests that need "something already exists" |
| `startHttpBackend()` | Starts a real `python3 -m http.server` process on the VM to prove traffic actually reaches it |
| `curlStatus()` / `waitForListener()` | Live HTTP checks against the real Caddy instance |
| `expectCaddyActive()` | Cheapest "did this config change break the daemon" check |

## Coverage by area

### Smoke / login

| File | Tests |
|---|---|
| `login.spec.ts` | logs into Cockpit and reaches the plugin · shows the Caddy page heading |
| `baseline.spec.ts` | plugin loads with empty proxy list |

### Core route types (Proxy List tab)

| File | What it covers | Tests |
|---|---|---|
| `proxy-workflows.spec.ts` | Reverse-proxy CRUD, duplicate, and port/host-sharing conflict rules | create proxy appears in the proxy list · create proxy writes correct Caddyfile block · edit proxy target updates the Caddyfile · edit proxy port removes old block and creates new block · delete proxy removes it from the list and the Caddyfile · duplicate proxy opens prefilled dialog that creates a distinct new entry · two standalone proxies can share a port via distinct subdomains · two proxies with explicit https:// scheme sharing a port keep distinct labels · two hostless proxies on the same port still conflict |
| `redirect-workflows.spec.ts` | Redirect routes — CRUD + live status/Location header | create redirect appears in the route list · create redirect writes correct Caddyfile block · edit redirect target updates the Caddyfile · delete redirect removes it from the list and the Caddyfile · redirect actually returns the configured status and Location header via curl · redirect on a port already used by a proxy is rejected |
| `static-workflows.spec.ts` | Static file-server routes — CRUD + real file serving | create static site appears in the route list · create static site writes correct Caddyfile block · edit static site root path updates the Caddyfile · delete static site removes it from the list and the Caddyfile · static site serves a real file via curl · static site returns 404 for a missing file · static site on a port already used by a redirect is rejected |
| `respond-workflows.spec.ts` | Fixed status/body "respond" routes — CRUD + live response | create respond route appears in the route list · create respond route writes correct Caddyfile block · edit respond status code updates the Caddyfile · delete respond route removes it from the list and the Caddyfile · respond route actually returns the configured status and body via curl · respond route on a port already used by a redirect is rejected |
| `php-fastcgi-workflows.spec.ts` | PHP-FastCGI sites | create PHP site writes a valid php_fastcgi Caddyfile block · PHP site with custom index/split/env round-trips through a reload · editing a PHP site updates the Caddyfile block · deleting a PHP site removes it from the list and the Caddyfile |
| `migrate-workflows.spec.ts` | Importing hand-edited Caddyfile blocks into managed conf.d | migrating a bare-hostname site block preserves its content and shows it in the proxy list · detects a hand-added block alongside an existing conf.d import, and migration is additive |

### Route matching & named servers

| File | What it covers | Tests |
|---|---|---|
| `route-matcher-workflows.spec.ts` | Path/host/method/header matchers, `@m` named-matcher generation, `handle`/`handle_path` | proxy with path matcher generates named @m block and handle wrapper · proxy with path matcher + handlePath generates handle_path block · handlePath checkbox hidden when non-path matchers are also present · proxy with host matcher writes host line in @m block · proxy with method matcher writes method line in @m block · proxy with header matcher writes header line in @m block · path + host matchers both appear in a single @m block (AND logic) · edit proxy: add path matcher to existing plain proxy regenerates block with @m wrapper · edit proxy: remove all matchers reverts to plain block without @m |
| `named-server-workflows.spec.ts` | Multi-route named servers, per-server tabs, route ordering/renumbering | create named server via UI — tab appears with display name and listen address · route added via server tab appears in that server's filtered view · matcher route is placed before catch-all route in Caddyfile block · deleting middle route renumbers remaining routes in conf (no ID gaps) · deleting last route of a named server removes the server tab · port conflict: cannot add standalone proxy on a named server's port · port conflict: cannot add named server on a standalone proxy's port · edit server display name updates the tab label · delete server (with routes) removes all routes and the server tab |
| `server-detail-workflows.spec.ts` | Named-server detail panel, TLS toggle, listen-address display | create server with TLS enabled — Caddyfile block contains tls directive · edit server: enable TLS on existing server — Caddyfile block updated with tls · server info card shows the listen address for the server |
| `route-link-workflows.spec.ts` | Route URL building for the proxy-list "open" link | route link uses the configured subdomain instead of the browser host · route link falls back to the current host when no subdomain is configured |

### TLS & certificates

| File | What it covers | Tests |
|---|---|---|
| `custom-tls-cert-workflows.spec.ts` | Custom certificate files served over real TLS | custom certificate is actually served over TLS, not the internal CA · a nonexistent certificate path fails validation without breaking the running config |
| `ca-modal-workflows.spec.ts` | Internal CA info modal | CA modal warns when no proxy uses the internal CA · CA modal shows no warning and offers intermediate chain when a proxy uses internal TLS |
| `acme-status-workflows.spec.ts` | Per-hostname TLS/ACME classification | classifies a bare public hostname as using Caddy default automatic HTTPS · classifies an internal-CA (self-signed) hostname distinctly · classifies an explicit http:// hostname as no TLS · shows the empty state when no public hostnames are configured · a default-ACME host stays classified as Caddy default even alongside an internal-CA host · Edit Proxy shows a note when the host is already ACME-managed |
| `on-demand-tls-workflows.spec.ts` | Global on-demand TLS settings | enabling on-demand TLS writes the correct global tls block · disabling on-demand TLS removes the block and Caddy still reloads cleanly |
| `http3-workflows.spec.ts` | HTTP/3 default-on behavior and per-port opt-out | disabling HTTP/3 writes a global servers block and Caddy accepts the reload · HTTP/3 stays enabled (no protocols restriction) by default · editing an unrelated proxy does not break when another port has HTTP/3 disabled |

### Per-route traffic shaping (AddProxyDialog accordion sections)

| File | What it covers | Tests |
|---|---|---|
| `rewrite-workflows.spec.ts` | URI rewrite (strip/add prefix, regex) | proxy with strip_prefix rewrite writes correct Caddyfile directive · proxy with regex rewrite writes matcher and rewrite directive · URI rewrite changes the path the backend actually receives · clearing rewrite on edit removes the directive from the Caddyfile |
| `request-headers-workflows.spec.ts` | Headers injected into the upstream request (`header_up`) | add request header preset writes correct Caddyfile directive · custom set/add/delete header operations write correct Caddyfile directives · request headers actually reach the backend · remove header operation updates the Caddyfile |
| `response-headers-workflows.spec.ts` | Headers added to the client response (`header`) | add response header (set) is visible in curl -I output · delete response header removes it from curl -I output · response headers persist across edit dialog reopen |
| `basic-auth-workflows.spec.ts` | Per-route HTTP Basic Auth (bcrypt hashing via `caddy hash-password`) | add basic auth user requires credentials for the route · basic auth password is stored as a bcrypt hash, not plaintext · remove basic auth user allows unauthenticated access again · edit password re-hashes and old password stops working |
| `upstreams-lb-retry-workflows.spec.ts` | Multiple upstreams, load-balancing policy, retry/failover tuning | adding a second upstream writes both to the reverse_proxy Caddyfile line · load balancing distributes requests across both live backends · failover: killing one backend still serves via the other · lb retry count and interval settings are written to the Caddyfile |
| `forward-auth-workflows.spec.ts` | `forward_auth` subrequest-based authentication | configuring forward_auth writes the correct Caddyfile directive · request is rejected when the forward_auth backend denies it · request passes through to the real backend when forward_auth approves it |
| `error-handlers-workflows.spec.ts` | Custom error pages keyed by upstream response status | custom error handler for 404 writes correct handle_errors block · custom error handler actually renders for a real 404 response · removing the error handler reverts to the default Caddy error page |
| `transport-timeouts-workflows.spec.ts` | Upstream dial/response timeouts + server-level read/write/idle timeouts | custom upstream dial/response timeouts are written to the transport block · server-level timeouts round-trip through edit and persist in the Caddyfile |
| `request-body-limit-workflows.spec.ts` | Max request body size enforcement | rejects a request body over the configured limit and allows one under it |
| `health-monitor-workflows.spec.ts` | Live upstream health-probe status dot | health monitor status dot updates live without page reload |

### Global settings (Settings tab)

| File | What it covers | Tests |
|---|---|---|
| `global-options-workflows.spec.ts` | Settings save doesn't corrupt unrelated existing proxies | saving Settings does not strip labels from existing TLS proxies |
| `metrics-workflows.spec.ts` | Prometheus metrics global option + dedicated site block | enabling metrics writes the global option and a dedicated site block Caddy accepts · a custom path and plain-format option round-trip correctly · disabling metrics removes both the global option and the site block · enabling without a listen address is blocked before saving |
| `storage-workflows.spec.ts` | Certificate storage backend path, including systemd sandbox write-permission checks | Settings shows the detected default storage path with disk usage and cert count · saving a custom storage root writes a valid global option Caddy accepts · an unwritable storage path is rejected before ever being saved · a path outside the systemd sandbox ReadWritePaths is rejected even though root can create it · a fresh directory under an allowed path is usable by the caddy user, not just root |
| `trusted-proxies-workflows.spec.ts` | `trusted_proxies` propagation to the *live* server, including the per-port `servers {}` merge edge case | trusted_proxies reaches the live server only after an explicit reload · trusted_proxies survives a per-port servers block also carrying an HTTP/3 override |
| `proxy-protocol-workflows.spec.ts` | PROXY protocol listener wrapper | enabling PROXY protocol writes the correct listener directive and Caddy accepts the reload · disabling PROXY protocol removes the directive and Caddy still reloads cleanly |
| `access-log-workflows.spec.ts` | Per-route access log + global runtime/error log | enabling per-route access log writes the correct log directive · a real request produces a log entry in the configured access log file · enabling the global runtime log writes the correct log directive |

### Admin & maintenance surfaces

| File | What it covers | Tests |
|---|---|---|
| `caddyfile-editor-workflows.spec.ts` | Raw Caddyfile tab (CodeMirror editor), validate-before-save | raw Caddyfile tab shows current on-disk content · editing and saving a valid Caddyfile updates the file and reloads successfully · saving an invalid Caddyfile surfaces a validation error and does not overwrite the file · saving unrelated changes does not drop an existing proxy route |
| `backup-restore-workflows.spec.ts` | tar-based config backup/restore | backup produces a tar archive containing the /etc/caddy config · restore from a backup tar replaces current config exactly · restore of a corrupt archive is rejected without touching existing config |
| `admin-address-workflows.spec.ts` | Admin API address dialog (TCP/Unix socket, localStorage-persisted) | test-connection button reports success against the real reachable admin socket · test-connection button reports failure against an unreachable address · save is disabled until a connection test succeeds, then persists the value · reset to defaults restores default fields and clears test results |
| `config-check-workflows.spec.ts` | Stale-directive scanner + apply-fix flow | stale cert_issuer directive is detected by the scanner · apply-fix flow removes the stale directive and Caddy reloads successfully · a clean config shows no issues |
| `service-control-workflows.spec.ts` | Toolbar Reload/Restart (Start/Stop deliberately excluded — see Known Gaps) | reload button reloads without dropping existing routes · restart button restarts Caddy and existing routes still serve traffic after |
| `logs-viewer-workflows.spec.ts` | Logs tab — polling, search filter | logs viewer shows recent Caddy log lines after a config reload · log filter narrows visible entries to matching text |

## Known gaps (deliberate scope-downs, not oversights)

These were evaluated and explicitly excluded — cost (VM time, implementation complexity,
flakiness risk) outweighed the signal a test would add:

- **PROXY protocol**: no raw TCP wire-protocol test (hand-crafting a v1/v2 preamble) —
  config-round-trip + reload-accepts only.
- **`respond` with `close_after`**: no live mid-stream connection-abort check — Caddyfile-
  directive correctness only.
- **Backup**: verified via the UI's own path-preview field + `tar -tzf` on the VM, not by
  intercepting a browser download event (unreliable across the 3 target VM browser stacks).
- **`ServiceControl` "Stop"**: not exercised — under this suite's `workers: 1` serialization,
  a stuck-stopped Caddy would cascade-fail every later spec sharing the VM.
- **Exhaustive status-code / error matrices**: forward-auth and error-handlers each test one
  representative status; every other status combination is covered at the unit level in
  `src/api/caddy.test.ts`, not here.
- **`AdminAddressDialog` filesystem-permission edge cases**: only the happy path + one
  unreachable-address failure are tested.
- **Cross-distro verification**: all specs run against the `arch` Playwright project only.
  `debian` and `fedora` projects exist in `playwright.config.ts` but aren't part of routine
  runs — worth doing before a release if distro-specific Caddy packaging ever diverges.

## Adding a new spec

1. Pick an unclaimed port range — see the table at the top of `e2e/helpers.ts` (specs share
   one Caddy instance under `workers: 1`; port collisions cause cross-test interference).
2. Follow the two-part pattern above: drive the real UI, then assert on-disk config *and*
   live behavior where relevant.
3. If a UI action's effect can lag the confirmation toast by a beat (live-push vs. Caddyfile
   convergence — several sections do this), use `expect.poll(...)` rather than a single
   assertion immediately after the action.
4. Update this page.
