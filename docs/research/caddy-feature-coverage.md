# Caddy feature coverage of cockpit-caddy

Research date: 2026-11-16. Caddy facts come from caddyserver.com docs and the `caddyserver/caddy`
source on `master` (line numbers as of that date). Plugin facts cite `file:line` in this repo.
Everything below comes from reading the code and docs. Nothing was run against a live Caddy, so a
"correctness concern" means the code and the docs/source disagree. It is not a reproduced bug.

## Tracked in issues (milestone v1.0.0)

| Finding | Issue |
|---|---|
| Static root read as `/` (found while testing, not in the list below) | #245 (fixed) |
| C1, gap 1: ACME / TLS mode | #246 |
| C2, gap 2: PHP static files | #247 |
| C5: forward_auth instant JSON | #248 |
| C9: timeout defaults | #249 |
| C3, gap 6: invalid matchers | #250 |
| C4, C17, gap 7: quoting | #251 |
| C6, gap 4: health checks | #252 |
| C8: on-demand TLS | #253 |
| C7, C10: instant JSON vs Caddyfile | #254 |
| C11 to C16: smaller fixes | #255 |
| Gap 3: DNS challenge | #261 |
| Gap 5: try_files / file_server options | #262 |
| Gaps 8, 9, 10: LB policies, matchers, snippets | #263 |

## Summary: top 10 gaps, ranked

| # | Gap | Why it ranks here |
|---|---|---|
| 1 | **No publicly trusted (ACME) certificates for GUI-made sites.** "TLS" always means `tls internal`, and editing a hand-written ACME site through the GUI rewrites it to `tls internal` (see C1). | Let's Encrypt for `app.example.com` is the main reason self-hosters pick Caddy. |
| 2 | **php_fastcgi without `file_server`.** CSS/JS/images of PHP apps aren't served (C2). | Breaks every real PHP app (WordPress, Nextcloud, phpMyAdmin). |
| 3 | **DNS challenge / wildcard certificates** (`acme_dns`, `tls { dns ... }`) are missing. | The only way to get certs behind CGNAT or for `*.example.com`. |
| 4 | **Active/passive health checks are missing.** `unhealthy_status` is written without `fail_duration`, so it does nothing (C6). | Needed as soon as there's more than one upstream. |
| 5 | **`try_files` / SPA fallback and file_server options** (`index`, `hide`, `precompressed`) are missing. | Very common for static frontends (React/Vue builds). |
| 6 | **Query matcher and header-presence matcher write invalid Caddyfile** (C3). | Features shown in the UI that fail `caddy validate`. |
| 7 | **Header values aren't quoted or escaped.** `header_up` / `header +` values with spaces turn into a regex replace, and `"` breaks `respond` bodies (C4). | Silent behaviour change on ordinary input. |
| 8 | **Sticky sessions and the other LB policies** (`ip_hash`, `client_ip_hash`, `cookie`, `header`, `uri_hash`, `weighted_round_robin`) are missing. | Needed by stateful apps behind several upstreams. |
| 9 | **`client_ip` matcher, `not` and `expression` matchers** are missing. Only `remote_ip` exists, which ignores `trusted_proxies`. | IP allow-lists behind Cloudflare/another proxy match the wrong IP. |
| 10 | **Snippets/`import` and per-site `tls { on_demand }`.** The global `on_demand_tls` is exposed, but nothing turns on-demand on for a site (C8). | Reuse across sites is a core Caddyfile workflow, and the on-demand UI promises more than it writes. |

The most serious correctness concerns (details in the last section): C1 (silent ACME → internal-CA
downgrade on edit), C2 (PHP static files), C5 (the instant-apply JSON for `forward_auth` copies the
auth headers to the **client** and doesn't strip client-supplied identity headers), and C9
(the "Defaults" button for server timeouts sets `read_body 5s` / `write 10s`, which cut off uploads and downloads).

## How the plugin stores config (and what that limits)

- **The Caddyfile is the source of truth.** Sites go into `/etc/caddy/conf.d/cockpit-caddy.conf`
  (`src/api/caddy.ts:280`), pulled in by an `import /etc/caddy/conf.d/*.conf` line added to the
  main Caddyfile when it has none (`src/api/caddy.ts:223-246`). Global options go into a marked
  section of the main Caddyfile's global block (`src/api/caddy.ts:3776-3779`, `4634-4656`).
- **Edits are surgical, per block.** A block whose header matches the plugin's own address shape is
  regenerated in full. Any other block is patched: top-level `tls`, `encode`, `root`,
  `file_server`, `header`, `basic_auth`, `forward_auth` and `reverse_proxy` are removed and
  re-emitted, and the remaining lines are kept (`src/api/caddy.ts:1550-1690`).
- **Two apply paths.** After the Caddyfile is validated and written, the plugin usually also builds a
  JSON server by hand and pushes it to the Admin API `/config/` for instant apply
  (`src/hooks/useProxies.ts:303`, `410`; `src/api/caddy.ts:199`, `3018-3090`). It reloads from
  the Caddyfile instead only for shared-port sites and php_fastcgi (`src/hooks/useProxies.ts:298`,
  `405`). **So until the next reload, the running config is the plugin's hand-built JSON, not what
  Caddy's adapter would produce from the saved Caddyfile.** Several concerns below come from those
  two differing.
- **Without a local `caddy` binary/systemd** the plugin posts the Caddyfile to `/load` with
  `text/caddyfile`, inlining conf.d itself because `/load` does not follow `import`
  (`src/api/caddy.ts:212-285`).
- **Plugin metadata lives in comments:** `# label:`, `# server:`, `# serverdef: {json}`,
  `# tls_ca_bundle:`, `# cockpit-caddy:internal-cert-lifetime` (`src/api/caddy.ts:1461`, `1308`,
  `3451`, `4355`).
- **Data model limit:** one standalone entry = one site block with **one** handler type
  (reverse_proxy | file_server | php_fastcgi | redir | respond, `src/api/types.ts:342-417`). Named
  servers hold several routes, each wrapped in `handle`/`handle_path` (`src/api/caddy.ts:3411-3513`).
  Anything outside this model (snippets, `route`, `map`, `try_files`, `templates`, plugins) can only be
  written in the **raw Caddyfile editor**, which edits the main Caddyfile and conf.d files
  (`src/components/CaddyfileEditor.tsx:21-36`).

## Coverage table

Status: **Full**, **Partial** (what's missing), **Missing**, **Raw-only** (possible only through the
raw Caddyfile editor). Priority = how often a self-hoster running Cockpit needs it.

| Area | Status | Missing / notes | Priority |
|---|---|---|---|
| Site addresses, multiple hosts | Partial | Standalone entry: one host + one port (`types.ts:344-349`). Named server: several listen addresses. No comma-separated multi-host block for standalone entries, no wildcard hosts, no `bind`. The host field doesn't control binding (C7). | High |
| Automatic HTTPS (public ACME) | **Missing** (Raw-only) | "TLS" = `tls internal` (`caddy.ts:1317`, `en.json:118`). ACME sites are only detected and shown (`caddy.ts:2547-2593`). | High |
| reverse_proxy, basic | Full | Upstream scheme/host/port, extra upstreams (`caddy.ts:1020-1025`). | High |
| reverse_proxy, load balancing | Partial | 4 of ~13 policies (`types.ts:295`, `caddy.ts:1027-1032`). No `ip_hash`/`cookie`/`header`/`weighted_round_robin`/`random_choose`, no `lb_retry_match`. | Med |
| reverse_proxy, health checks | **Missing** | No `health_uri`/`health_*`, no `fail_duration`/`max_fails`. `unhealthy_status` is written alone and has no effect (C6). | High |
| reverse_proxy, transport | Partial | Only `dial_timeout`, `response_header_timeout`, `tls_insecure_skip_verify` (`caddy.ts:996-1006`). No `tls_server_name`, `tls_trust_pool`, `keepalive`, `versions h2c/2`, `read/write_timeout`. | Med |
| reverse_proxy, headers | Partial | `header_up` set/add/delete (`caddy.ts:1051-1055`). No `header_down`, no replace ops. Values unquoted (C4). | Med |
| reverse_proxy, streaming | Missing | No `flush_interval`, `stream_timeout`, `stream_close_delay`. | Low |
| reverse_proxy, dynamic upstreams | Missing | `srv`/`a`/`multi` | Low |
| file_server | Partial | `root`, `browse` only (`caddy.ts:1403-1404`, `types.ts:270-273`). No `index`, `hide`, `precompressed`, `disable_canonical_uris`, browse options, `status`. | Med |
| try_files / SPA fallback | **Missing** (Raw-only) | — | High |
| php_fastcgi | Partial, **broken** | `upstream`, `root`, `index`, `split`, `env` (`caddy.ts:1405-1428`). No `file_server` (C2), no `try_files`, `capture_stderr`, `resolve_root_symlink`, timeouts. | High |
| redir | Partial | Fixed target + 301/302/307/308 (`types.ts:265-268`, `caddy.ts:1390`). Placeholders like `{uri}` only if typed by hand. No `html` mode, no "preserve path" option. | Med |
| respond | Full | Status, body, `close` (`caddy.ts:1374-1389`). Body not escaped (C4). | Low |
| rewrite / uri | Partial | strip_prefix, add_prefix, regex (`types.ts:260-263`). Regex behaves differently in JSON and Caddyfile (C10). No `uri replace`, `strip_suffix`, query ops, method rewrite. | Med |
| handle / handle_path / route | Partial | `handle @m`, `handle_path` (single path only, C11), named routes `&(name)` + `invoke` (`caddy.ts:3417-3421`, `3489-3498`). No `route` (literal order), no nested handles. | Med |
| Matchers | Partial | path, host, method, header, query, remote_ip (`types.ts:57-66`). Query and header-presence write invalid syntax (C3). Missing: `client_ip`, `not`, `expression`, `path_regexp`, `header_regexp`, `protocol`, `file`, `vars`. | High (client_ip), Med (rest) |
| header (response) | Partial | set/add/delete (`caddy.ts:1399-1401`). No `defer`/`>`/`?`/replace. Set ops on proxied routes are not deferred (C12). | Med |
| encode | Partial | On/off only, writes `encode gzip zstd` (`caddy.ts:1430`), so gzip wins over Caddy's default zstd. No `minimum_length`/`match`. | Low |
| basic_auth | Full | Hash via `caddy hash-password` (`caddy.ts:3270-3276`), but the plaintext goes in argv (C13). No realm, no hash-algorithm choice. | Med |
| forward_auth | Partial | `uri`, `copy_headers` (`types.ts:333-340`). No `header_up`, `trusted_proxies`, or renaming `copy_headers A>B`. JSON path is wrong (C5). | High |
| TLS: internal CA | Full | Lifetime, renewal window, protocols, ciphers, curves (`caddy.ts:1285-1365`). | High |
| TLS: custom cert files | Full | `tls cert key` (`caddy.ts:1303-1314`). | Med |
| TLS: client auth / mTLS | Partial | `mode` + single `trusted_ca_cert_file`, which is deprecated (C14). No `trust_pool` options, no `verifier`. | Low |
| TLS: DNS challenge | **Missing** | Needs caddy-dns plugins. Not even a raw-text field. | High |
| TLS: on-demand | Partial | Global `on_demand_tls` only (`caddy.ts:4587-4593`). No per-site `tls { on_demand }` (C8). | Low |
| TLS: per-site email/ca/key_type | Missing | Global `email`/`acme_ca`/`acme_ca_root`/`acme_eab` exist (`caddy.ts:4578-4586`). | Low |
| Access log | Partial | Output, file, rotation, format, level (`caddy.ts:1207-1283`). No `include`/`exclude` filters, field filters, `log_skip`. | Med |
| Runtime log (global `log`) | Partial | Same fields (`caddy.ts:4610`). Only the default logger. | Low |
| request_body | Full | `max_size` (`caddy.ts:1372-1373`). | Low |
| handle_errors | Partial | Code lists / 4xx / 5xx / all → respond / redir / static `{code}.html` (`caddy.ts:1174-1205`). Upstream errors are re-raised as 400/500 (C15) and replace application error bodies (C16). | Med |
| templates | Missing (Raw-only) | — | Low |
| import / snippets | Missing (Raw-only) | Only the plugin's own conf.d import. | Med |
| metrics | Full | Global `metrics` + a dedicated site (`caddy.ts:4607`, `4711-4723`). No `per_host`. | Low |
| Global: ports, debug, grace, shutdown_delay | Full | `caddy.ts:4573-4577` | Low |
| Global: email, acme_ca, acme_ca_root, acme_eab | Full | Only matters for raw-written ACME sites, given gap 1. | Med |
| Global: admin | Missing | The admin address dialog only stores where the plugin connects, in the browser (`en.json:638`). It doesn't write `admin`. | Low |
| Global: storage | Full | `file_system` root (`caddy.ts:4598-4602`). | Low |
| Global: servers | Partial | timeouts, `max_header_size`, `protocols h1 h2`, `trusted_proxies`(+strict, headers), `proxy_protocol` (`caddy.ts:3863-3917`, `4619-4626`). No `read_body_idle`, `keepalive_*`, `strict_sni_host`, `log_credentials`, `enable_full_duplex`. HTTP/3 can only be turned off. | Med |
| Global: auto_https, local_certs, default_sni, key_type, cert_issuer, ocsp, preferred_chains, default_bind | Missing | — | Low |
| layer4, caddy-dns, other modules | Missing (Raw-only) | The plugin doesn't check which modules the binary has (`caddy list-modules`). | Low |

## Notes by area

### Site addresses and binding
`buildExternalAddress` emits `http://[host]:port` when TLS is off and `[scheme://][host]:port`
when it's on (`src/api/caddy.ts:1111-1138`). Caddy docs: "By default, sites bind on all network
interfaces … use the bind directive or the default_bind global option" to restrict, and the host
in an address only affects matching on `Host`
([concepts](https://caddyserver.com/docs/caddyfile/concepts#addresses)). Several addresses per
block are allowed ("with spaces and commas", same source). Named servers use this
(`caddy.ts:3433-3435`), standalone entries can't.

### TLS / ACME
- Caddy issues public certs automatically for public names. Wildcards need the DNS challenge,
  and the HTTP/TLS-ALPN challenges need ports 80/443
  ([automatic-https](https://caddyserver.com/docs/automatic-https)).
- DNS providers "must be plugged in from one of the caddy-dns repositories"
  ([tls](https://caddyserver.com/docs/caddyfile/directives/tls)). Supporting them means detecting
  modules and offering a raw provider block, or only a raw text field.
- The plugin's TLS switch is labelled "Enable TLS (self-signed via Caddy internal CA)"
  (`src/i18n/locales/en.json:118`) and always yields `tls internal` or `tls { issuer internal … }`
  (`caddy.ts:1317-1333`). A three-way choice (Automatic/ACME, Internal, Custom files, Off) would close gap 1.

### reverse_proxy
LB policies, health checks, transports and `handle_response` are documented at
[reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Relevant points:
"Retries are disabled by default". Passive health checks: "To enable this, `fail_duration` is
required". Status-based retries need `lb_retry_match` with an expression on `{rp.status_code}`.
`handle_response` has `{rp.status_code}` available. The http transport defaults are `dial_timeout`
3s and `response_header_timeout` none.

### Matchers
The standard matchers are listed at [matchers](https://caddyserver.com/docs/caddyfile/matchers),
which says `client_ip` should be used with `trusted_proxies`; without it, `client_ip` "acts
identically to the remote_ip matcher". The plugin configures `trusted_proxies` globally
(`caddy.ts:1222-1233`) but only offers `remote_ip` (`caddy.ts:735-737`), which always matches the
direct peer. Behind a reverse proxy or tunnel, an IP allow-list then matches the proxy's address.

### Global options
The list is at [options](https://caddyserver.com/docs/caddyfile/options). The plugin knows 14 keys
(`caddy.ts:4336-4340`). `servers :PORT` blocks replace the global `servers` block for that port.
The plugin handles this by copying trusted_proxies/proxy_protocol into each per-port block
(`caddy.ts:3900-3907`). That matches the docs ("Can be specified more than once with different
`listener_address` values").

## Correctness concerns

**C1. Editing an ACME site through the GUI turns it into an internal-CA site.**
A hand-written site like `app.example.com { reverse_proxy … }` is read as `tls: true`
(`serverHasTls`, `caddy.ts:2651-2660`; `parseConfTlsMap`, `caddy.ts:544-561`). On save,
`patchRawBlock` removes any top-level `tls` line (`caddy.ts:1564-1568`) and re-adds
`buildTlsCaddyLines`, which emits `tls internal` (`caddy.ts:1629`, `1317`). A header like
`app.example.com:443 {` counts as plugin format and is regenerated in full with the same result
(`caddy.ts:1674`). Unchecking TLS writes `http://` instead. Either way the site loses its
publicly trusted certificate without any warning. Caddy uses the public ACME issuer by default for
such names ([automatic-https](https://caddyserver.com/docs/automatic-https)).

**C2. PHP sites don't serve static files.** The php route emits `root` + `php_fastcgi` and no
`file_server` (`caddy.ts:1405-1428`). Caddy: php_fastcgi "should almost always be paired with"
`root` and `file_server`. Its expansion rewrites existing non-PHP files to themselves and proxies
only `*.php` ([php_fastcgi](https://caddyserver.com/docs/caddyfile/directives/php_fastcgi)), so
requests for CSS/JS/images reach no handler.

**C3. The query matcher and the header-presence matcher write invalid syntax.**
- `query ${param} ${vals}` (`caddy.ts:732`) writes `query debug true`. Caddy's parser requires
  `param=val` and returns "malformed query matcher token … must be in param=val format"
  ([matchers.go L1051-1072](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/matchers.go#L1051-L1072)).
  The JSON form the plugin builds (`caddy.ts:181-185`) is fine, but the Caddyfile is validated first.
- `header ${hdr}` with no value (`caddy.ts:727`) is what the wiki calls "match header presence".
  Caddy returns "malformed header matcher: expected both field and value"
  ([matchers.go L1181-1183](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/matchers.go#L1157-L1195)).
  Use `header Name *` for presence.
- The UI accepts both (`src/components/RouteMatchersSection.tsx:106-130`), and the e2e suite only
  covers a header matcher with a value (`e2e/route-matcher-workflows.spec.ts:118-134`).

**C4. Values aren't quoted or escaped.**
- `header_up ${name} ${value}` and `header +${name} ${value}` are written unquoted
  (`caddy.ts:1053-1054`, `1400`). A value with a space becomes 3 arguments, which Caddy reads as a
  find/replace op, not a set
  ([headers/caddyfile.go L262-277](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/headers/caddyfile.go#L240-L295);
  syntax `[<value>|<find>] [<replace>]` in [header](https://caddyserver.com/docs/caddyfile/directives/header)).
- `respond "${body}"` (`caddy.ts:1377`, `1194`) and `header X "${value}"` (`caddy.ts:1401`)
  break on a `"` in the input, and a body with newlines needs a heredoc
  ([respond](https://caddyserver.com/docs/caddyfile/directives/respond)).

**C5. The instant-apply JSON for forward_auth differs from Caddy's own `forward_auth`.**
`buildForwardAuthHandler` (`caddy.ts:817-843`) uses `copy_response_headers` in the 2xx
`handle_response`. That handler adds the auth response headers to the **response to the client**
(`rw.Header().Add`,
[copyresponse.go L145-180](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/copyresponse.go#L145-L180)).
Caddy's `forward_auth` instead deletes each client-supplied header and then sets it on the
**request to the backend** from `{http.reverse_proxy.header.*}`
([forwardauth/caddyfile.go L208-255](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go#L208-L262)).
Until the next reload, the backend gets no `Remote-User` from the auth service, and a client can
send its own `Remote-User`. The builder also strips `https://` from the auth URL and dials it as
plain HTTP (`caddy.ts:819`). The JSON is pushed after every standalone add/edit
(`useProxies.ts:303`, `410`; `caddy.ts:3078-3081`). Suggested fix: reload from the Caddyfile
whenever forward_auth is set, as is already done for php_fastcgi.

**C6. `unhealthy_status` alone does nothing, and the UI describes it wrongly.** The plugin writes
`unhealthy_status` without `fail_duration` (`caddy.ts:1041`). The UI says the codes "trigger
retrying a different upstream" (`en.json:301`, `types.ts:308-310`). Caddy: passive health checks
need `fail_duration`, and status-based retries need `lb_retry_match` with `{rp.status_code}`
([reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)).

**C7. The host field doesn't control binding the way the code says, and the two apply paths
disagree.** `ProxyEntry.externalHost` is documented as "hostname/IP for the external listener;
omit to bind all interfaces" (`types.ts:347-348`). The instant JSON binds `IP:port` when the host
is an IP (`caddy.ts:2490-2494`). The saved Caddyfile `192.168.1.5:8443 {` binds all interfaces
and only matches on `Host` ([concepts](https://caddyserver.com/docs/caddyfile/concepts#addresses)).
After a reload the port opens on every interface.

**C8. "Enable on-demand TLS" doesn't enable it.** Caddy: `on_demand_tls` "configures On-Demand TLS
where it is enabled, but does not enable it", and you turn it on with `tls { on_demand }`. Caddy
also says `interval`/`burst` "are NOT recommended. Remove them"
([options](https://caddyserver.com/docs/caddyfile/options)). The plugin writes only the global
option, with interval/burst (`caddy.ts:4587-4593`), and its help text promises certificates "at
connection time" and calls no rate limit "not recommended" (`en.json:528`, `534`).

**C9. The "Defaults" button for server timeouts uses values that aren't Caddy's defaults and are
too short.** It sets read 5s, read_header 2s, write 10s, idle 5m, max header 1 MiB
(`src/components/ServerTimeoutsSection.tsx:25-32`). These are written as `read_body`/`write`
(`caddy.ts:3891-3894`). Caddy: `read_body` is "a hard limit on the whole upload", default none.
`write` default none. `read_header` default 1m. `max_header_size` default 16KiB
([options](https://caddyserver.com/docs/caddyfile/options)). With these values, any upload over 5 s
or download over 10 s fails. The transport "Defaults" (dial 10s, response header 30s,
`TransportSection.tsx:16`) also differ from Caddy's 3s/none, and 30s cuts off slow or long-polling
responses.

**C10. Regex rewrite means different things in the instant-apply JSON and after a reload.**
JSON: `rewrite.path_regexp` does a substring replace on the path (`caddy.ts:967`). Caddyfile:
`@rw path_regexp rw <find>` + `rewrite @rw <replace>` replaces the **whole URI**
(`caddy.ts:989-990`). For a pattern like `old` → `new`, the JSON gives `/x/new/y` and the
Caddyfile gives `new`. `uri path_regexp <find> <replace>` matches the JSON behaviour
([uri](https://caddyserver.com/docs/caddyfile/directives/uri)).

**C11. handle_path with several paths.** The plugin writes `handle_path /a/* /b/*`
(`caddy.ts:1469-1472`, `3470`), and the strip checkbox shows for any number of paths
(`AddPhpFastcgiDialog.tsx:279`). Caddy: "Only a single path matcher is accepted"
([handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)). The parser reads
only the first argument, then re-parses the segment, which rejects extra args on the first line
([rewrite/caddyfile.go L236-262](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/rewrite/caddyfile.go#L226-L262),
[directives.go L377-381](https://github.com/caddyserver/caddy/blob/master/caddyconfig/httpcaddyfile/directives.go#L374-L381)).
Expect a validation error, or at best only the first path working.

**C12. Response header set ops aren't deferred in the Caddyfile.** The JSON comment says the
Caddyfile adapter sets `deferred` automatically (`caddy.ts:2390-2397`). It does so only for delete
(`-`), default (`?`), `>`, or `defer`, not for a plain set
([headers/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/headers/caddyfile.go#L240-L295);
[header](https://caddyserver.com/docs/caddyfile/directives/header)). reverse_proxy then *adds* the
upstream's headers (`dst.Add`,
[reverseproxy.go L1525, L1879-1885](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/reverseproxy.go#L1879-L1885)).
After a reload, a header the upstream also sends (e.g. `X-Frame-Options`, `Cache-Control`)
appears twice. Emit `>Name value` or `defer` on proxied routes.

**C13. Basic-auth passwords go in argv.** `caddy hash-password --plaintext <pw>`
(`caddy.ts:3270-3276`). While the command runs, any local user can read the password from
`/proc/*/cmdline`. Feeding it on stdin avoids that.

**C14. `trusted_ca_cert_file` is deprecated.** It's emitted at `caddy.ts:1359`. Caddy logs "The
'trusted_ca_cert_file' field is deprecated. Use the 'trust_pool' field instead"
([connpolicy.go L708-709](https://github.com/caddyserver/caddy/blob/master/modules/caddytls/connpolicy.go#L708-L711)).
The documented form is `trust_pool file <pem>`
([tls](https://caddyserver.com/docs/caddyfile/directives/tls)).

**C15. 4xx/5xx error handlers change the status the client gets.** Upstream errors are re-raised
with `error 400` / `error 500` (`caddy.ts:1073-1086`), so a 404 from the upstream reaches a "4xx"
handler as 400. The code comment says the status argument can't take a placeholder. That's true for
the one-argument form only. With two arguments, `error "<msg>" {rp.status_code}` stores the status
as a string and resolves it at runtime
([staticerror.go L61-108](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticerror.go#L54-L108)).
That keeps exact codes with one handler. Separately, `respond` inside `handle_errors` correctly
keeps the error status when none is given
([staticresp.go L226-242](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticresp.go#L226-L242)).

**C16. Error handlers on a proxy replace the application's own error responses.** Caddy's
`handle_errors` normally fires only for errors Caddy itself raises
([handle_errors](https://caddyserver.com/docs/caddyfile/directives/handle_errors)). The plugin also
intercepts upstream responses through `handle_response` (`caddy.ts:1073-1086`), so an app's JSON
404/409 or a 401 with `WWW-Authenticate` gets replaced by the configured page. This is a deliberate
design choice, but the UI should say so, for example with an "also intercept upstream errors" toggle.

**C17. php_fastcgi `env` values are written unquoted** (`caddy.ts:1424`). A value with spaces
gets split into extra arguments.

## Sources

Caddy documentation:
- Directives index and default order: https://caddyserver.com/docs/caddyfile/directives
- Global options: https://caddyserver.com/docs/caddyfile/options
- Request matchers: https://caddyserver.com/docs/caddyfile/matchers
- Caddyfile concepts (addresses, binding, snippets, named routes): https://caddyserver.com/docs/caddyfile/concepts
- Automatic HTTPS: https://caddyserver.com/docs/automatic-https
- reverse_proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- tls: https://caddyserver.com/docs/caddyfile/directives/tls
- handle_errors: https://caddyserver.com/docs/caddyfile/directives/handle_errors
- handle_path: https://caddyserver.com/docs/caddyfile/directives/handle_path
- error: https://caddyserver.com/docs/caddyfile/directives/error
- respond: https://caddyserver.com/docs/caddyfile/directives/respond
- header: https://caddyserver.com/docs/caddyfile/directives/header
- uri: https://caddyserver.com/docs/caddyfile/directives/uri
- encode: https://caddyserver.com/docs/caddyfile/directives/encode
- php_fastcgi: https://caddyserver.com/docs/caddyfile/directives/php_fastcgi
- file_server: https://caddyserver.com/docs/caddyfile/directives/file_server

Caddy source (`master`, fetched 2026-11-16):
- modules/caddyhttp/staticerror.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticerror.go
- modules/caddyhttp/staticresp.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticresp.go
- modules/caddyhttp/matchers.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/matchers.go
- modules/caddyhttp/headers/caddyfile.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/headers/caddyfile.go
- modules/caddyhttp/rewrite/caddyfile.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/rewrite/caddyfile.go
- caddyconfig/httpcaddyfile/directives.go: https://github.com/caddyserver/caddy/blob/master/caddyconfig/httpcaddyfile/directives.go
- modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go
- modules/caddyhttp/reverseproxy/copyresponse.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/copyresponse.go
- modules/caddyhttp/reverseproxy/reverseproxy.go: https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/reverseproxy.go
- modules/caddytls/connpolicy.go: https://github.com/caddyserver/caddy/blob/master/modules/caddytls/connpolicy.go

Plugin files read: `src/api/caddy.ts`, `src/api/types.ts`, `src/hooks/useProxies.ts`,
`src/components/{RouteMatchersSection,ServerTimeoutsSection,TransportSection,UpstreamsSection,GlobalOptionsTab,CaddyfileEditor,AdminAddressDialog,AddPhpFastcgiDialog}.tsx`,
`src/i18n/locales/en.json`, `docs/wiki/{Managing-Proxies,Global-Options}.md`,
`e2e/route-matcher-workflows.spec.ts`. The repo has no `GLOSSARY.md` or `docs/adr/`.
