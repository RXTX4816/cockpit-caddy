# Caddy feature coverage of cockpit-caddy

Research date: 2026-11-16. Caddy facts come from caddyserver.com docs and the `caddyserver/caddy`
source on `master` (line numbers as of that date). Plugin facts cite `file:line` in this repo.
Everything below comes from reading the code and docs. Nothing was run against a live Caddy, so a
"correctness concern" means the code and the docs/source disagree. It is not a reproduced bug.

Updated: 2026-11-26, against `main` at `95344f3` (after #366). The coverage table, the
"How the plugin stores config" section and the status of C1 to C17 describe that state. Since the
first version, `src/api/caddy.ts` was split into `siteBlocks.ts` (Caddyfile text of a site),
`caddyJsonModel.ts` (the JSON push and read-back), `globalOptions.ts`, `caddyfileDocument.ts` and
`siteEditing.ts` (#356). File references in the table and in the status lines point at the new
files. The original text of each concern is kept below its status line, with its old `caddy.ts`
line numbers. C18 and C19 are new: found while checking this update, by reading `patchRawBlock`
and running it on sample blocks in a unit test, not against a live Caddy.

## Remaining gaps before 1.0

1. **Editing a hand-written site block loses or breaks settings (C18, C19).** A block whose header
   isn't the plugin's `host:port` shape (e.g. `app.example.com {`) goes through `patchRawBlock`.
   A redirect or respond site gets `reverse_proxy http://:0` added. Changes to rewrite, request
   body limit, access log and matchers aren't written, and error handlers are added a second time.
2. **One handler and one rewrite per standalone site.** A site is one of reverse_proxy /
   file_server / php_fastcgi / redir / respond, with at most one rewrite (`types.ts:556-592`).
   Anything with several steps needs a named server, the Tree tab or the raw editor.
3. **reverse_proxy leftovers.** `handle_response` / `copy_response`, request and response
   buffers, upstream TLS trust pool and client certificate (`tls_trust_pool`,
   `tls_client_auth`), `lb_retry_match` beyond methods, and active-check `health_headers`,
   `health_port`, `health_body`, `health_passes` / `health_fails` are Raw-only.
4. **Error pages.** `handle_errors` can only respond, redirect or serve `{code}.html`
   (`types.ts:523-541`). No proxying to an error service, no matchers of its own.
5. **mTLS.** Only `mode` and a `trust_pool file`. No other pool sources, no `verifier`
   (`siteBlocks.ts:651-660`).
6. **Response `header`.** set / add / delete only. No `?` default and no replace
   (`RequestHeadersSection.tsx:150`).
7. **try_files on static sites.** Only the SPA preset `try_files {path} /index.html`
   (`siteBlocks.ts:682`). A free `try_files` line exists for PHP sites only.
8. **Runtime log.** Only Caddy's default logger. No named loggers.
9. **servers protocols.** HTTP/3 can only be turned off (`caddy.ts:959`). No `h2c`, no other
   `listener_wrappers` besides `proxy_protocol`.
10. **Raw-only directives and options.** Directives `map`, `vars`, `abort`, `error`, `intercept`,
    `acme_server`, `tracing`, `fs`, `log_append`, snippet arguments (`import name args`). Global
    `order`, `persist_config`, `pki`, `events`, `cert_lifetime`, `renew_interval`,
    `ocsp_interval`, `skip_install_trust`. Modules layer4, rate limiting and caddy-security are
    detected (`caddyModules.ts:1-10`) but not configurable.

## Tracked in issues (milestone v1.0.0)

| Finding | Issue | Fixed in |
|---|---|---|
| Static root read as `/` (found while testing, not in the list below) | #245 | #265 |
| C1, gap 1: ACME / TLS mode | #246 | #279 |
| C2, gap 2: PHP static files | #247 | #274 |
| C5: forward_auth instant JSON | #248 | #271 |
| C9: timeout defaults | #249 | #275 |
| C3, gap 6: invalid matchers | #250 | #272 |
| C4, C17, gap 7: quoting | #251 | #273 |
| C6, gap 4: health checks | #252 | #276 |
| C8: on-demand TLS | #253 | #280 |
| C7, C10: instant JSON vs Caddyfile | #254 | #277, #365 (C7 bind) |
| C11 to C16: smaller fixes | #255 | #311 |
| Gap 3: DNS challenge | #261, #289 | #313, #317 |
| Gap 5: try_files / file_server options | #262, #340 | #313, #359 |
| Gaps 8, 9, 10: LB policies, matchers, snippets | #263, #285, #286, #287, #288 | #313, #295, #296 |
| Remaining table rows | #323 to #343 | #357 to #364 |
| Tree tab for `route` / nested `handle` | #348 to #351 | #362 |

## Summary: top 10 gaps, ranked

All ten were closed between 2026-11-16 and 2026-11-26. The table is kept as it was ranked, with
the fix added.

| # | Gap | Why it ranks here | Now |
|---|---|---|---|
| 1 | **No publicly trusted (ACME) certificates for GUI-made sites.** "TLS" always means `tls internal`, and editing a hand-written ACME site through the GUI rewrites it to `tls internal` (see C1). | Let's Encrypt for `app.example.com` is the main reason self-hosters pick Caddy. | Fixed, #279 |
| 2 | **php_fastcgi without `file_server`.** CSS/JS/images of PHP apps aren't served (C2). | Breaks every real PHP app (WordPress, Nextcloud, phpMyAdmin). | Fixed, #274 |
| 3 | **DNS challenge / wildcard certificates** (`acme_dns`, `tls { dns ... }`) are missing. | The only way to get certs behind CGNAT or for `*.example.com`. | Fixed, #313, #317 |
| 4 | **Active/passive health checks are missing.** `unhealthy_status` is written without `fail_duration`, so it does nothing (C6). | Needed as soon as there's more than one upstream. | Fixed, #276 |
| 5 | **`try_files` / SPA fallback and file_server options** (`index`, `hide`, `precompressed`) are missing. | Very common for static frontends (React/Vue builds). | Fixed, #313, #359 |
| 6 | **Query matcher and header-presence matcher write invalid Caddyfile** (C3). | Features shown in the UI that fail `caddy validate`. | Fixed, #272 |
| 7 | **Header values aren't quoted or escaped.** `header_up` / `header +` values with spaces turn into a regex replace, and `"` breaks `respond` bodies (C4). | Silent behaviour change on ordinary input. | Fixed, #273 |
| 8 | **Sticky sessions and the other LB policies** (`ip_hash`, `client_ip_hash`, `cookie`, `header`, `uri_hash`, `weighted_round_robin`) are missing. | Needed by stateful apps behind several upstreams. | Fixed, #313 |
| 9 | **`client_ip` matcher, `not` and `expression` matchers** are missing. Only `remote_ip` exists, which ignores `trusted_proxies`. | IP allow-lists behind Cloudflare/another proxy match the wrong IP. | Fixed, #313, #295 |
| 10 | **Snippets/`import` and per-site `tls { on_demand }`.** The global `on_demand_tls` is exposed, but nothing turns on-demand on for a site (C8). | Reuse across sites is a core Caddyfile workflow, and the on-demand UI promises more than it writes. | Fixed, #296, #280 |

The most serious correctness concerns (details in the last section): C1 (silent ACME → internal-CA
downgrade on edit), C2 (PHP static files), C5 (the instant-apply JSON for `forward_auth` copies the
auth headers to the **client** and doesn't strip client-supplied identity headers), and C9
(the "Defaults" button for server timeouts sets `read_body 5s` / `write 10s`, which cut off uploads and downloads).
All four are fixed. The most serious open ones are now C18 and C19.

## How the plugin stores config (and what that limits)

- **The Caddyfile is the source of truth.** Sites go into `/etc/caddy/conf.d/cockpit-caddy.conf`
  (`src/api/caddy.ts:406`), pulled in by an `import /etc/caddy/conf.d/*.conf` line added to the
  main Caddyfile when it has none (`src/api/caddy.ts:258-271`, `caddyfileDocument.ts:9-33`). A
  distro's stock Caddyfile is migrated into conf.d on the first save (#256, `caddy.ts:262-267`).
  Snippets go into `/etc/caddy/conf.d/cockpit-caddy-snippets.conf`, which sorts before the sites
  file (`caddy.ts:408`, `snippets.ts:1-6`). DNS challenge credentials go into the root-only
  `/etc/caddy/dns.env` and are referenced as `{env.NAME}` (`dnsChallenge.ts:10`, `types.ts:698-713`).
  Global options go into marked sections of the main Caddyfile's global block
  (`globalOptions.ts:111-117`, `125-163`).
- **Edits are surgical, per block.** A block whose header matches the plugin's own address shape is
  regenerated in full (`siteBlocks.ts:1026-1033`). Any other block is patched by `patchRawBlock`:
  `tls`, `bind` and snippet imports are written again where they stood, `encode`, `root`,
  `templates`, `file_server`, `header`, `basic_auth`, `forward_auth`, `reverse_proxy`,
  `php_fastcgi` (and `try_files` on static/PHP sites) are removed and re-emitted, and the remaining
  lines are kept (`siteBlocks.ts:892-999`). That patch path is where C18 and C19 come from. A block
  with `route` or nested `handle` blocks is never regenerated: the form only writes its address,
  binds, imports and TLS, and the Tree tab edits the blocks (`siteBlocks.ts:911-916`, `1027-1029`).
- **Two apply paths, still.** After the Caddyfile is validated and written, the plugin either
  reloads Caddy from it or pushes a hand-built JSON config to the Admin API `/config/`
  (`siteEditing.ts:29-30`, `src/hooks/useProxies.ts:147-162`, `caddy.ts:208-212`). Reload is now the
  default for everything the JSON can't build the same way: php_fastcgi, automatic HTTPS and
  on-demand TLS, snippet imports, a `client_ip` matcher, sites with nested blocks, a matcher
  change, and shared-port sites (`siteEditing.ts:46-65`, `205`, `268-270`). Any site using automatic
  HTTPS turns every JSON push into a reload (`siteEditing.ts:84-86`). Tree tab edits always reload
  (`siteEditing.ts:283-292`). The JSON push remains for simple standalone sites and named servers.
  It is checked against Caddy's own adapter in `src/api/caddyAdapt.test.ts`, which runs the
  generated Caddyfile through a real `caddy adapt` in CI and compares the result with the pushed
  JSON. **So the running config is still the plugin's hand-built JSON until the next reload, but
  the known differences (C5, C7, C10) are fixed and tested.**
- **Reload** is `systemctl reload caddy` for a local service, or a `/load` of the flattened
  Caddyfile for a Caddy without local systemd. Moving the admin endpoint reloads over the old
  address (#330, `caddy.ts:881-898`).
- **Without a local `caddy` binary/systemd** the plugin posts the Caddyfile to `/load` with
  `text/caddyfile`, inlining conf.d itself because `/load` does not follow `import`
  (`caddy.ts:222-310`). Checks use `/adapt` (`caddy.ts:238-251`).
- **Plugin metadata lives in comments:** `# label:`, `# server:`, `# serverdef: {json}`,
  `# tls_ca_bundle:`, `# cockpit-caddy:internal-cert-lifetime`, and the `# cockpit-caddy:*:begin/end`
  section markers (`siteBlocks.ts:842`, `1281`, `584`; `globalOptions.ts:111-117`, `300`, `792-794`).
- **Data model limit:** one standalone entry = one site block with **one** handler type
  (reverse_proxy | file_server | php_fastcgi | redir | respond, `src/api/types.ts:556-688`). Named
  servers hold several routes, each wrapped in `handle`/`handle_path` (`siteBlocks.ts:1240-1350`).
  `route` and nested `handle` / `handle_path` blocks are shown and edited in the site's **Tree
  tab** (`siteTree.ts:28`, `src/components/SiteTreeView.tsx`); other directives inside them stay as
  written. Anything else outside the model (`map`, `vars`, plugins, see the gap list) can only be
  written in the **raw Caddyfile editor** (`src/components/CaddyfileEditor.tsx`).

## Coverage table

Status: **Full**, **Partial** (what's missing), **Missing**, **Raw-only** (possible only through the
raw Caddyfile editor). Priority = how often a self-hoster running Cockpit needs it.

| Area | Status | Missing / notes | Priority |
|---|---|---|---|
| Site addresses, multiple hosts | Full | Several names per site (#208, `siteBlocks.ts:480-487`, `externalHosts.ts`), wildcard names (DNS warning `en.json:1244`), `bind` next to the host (#323, `siteBlocks.ts:1102-1122`). Named servers: several listen addresses. Editing a hand-written block has bugs (C18, C19). | High |
| Automatic HTTPS (public ACME) | Full | TLS mode Automatic / Internal CA / Off (`TlsModeField.tsx:9-30`), custom files separately. Automatic writes no `tls` line, or a `tls { }` with the site's own settings (`siteBlocks.ts:593-608`). A hostless site keeps the internal CA. | High |
| reverse_proxy, basic | Full | Upstream scheme/host/port, extra upstreams (`siteBlocks.ts:331-336`). | High |
| reverse_proxy, load balancing | Full | All 11 policies with their arguments (`types.ts:475-491`, `siteBlocks.ts:339-360`). `lb_retry_match` only takes methods (`siteBlocks.ts:370`). | Med |
| reverse_proxy, health checks | Partial | Passive `fail_duration`, `max_fails`, `unhealthy_status`; active `health_uri`, `_interval`, `_timeout`, `_status` (`siteBlocks.ts:364-385`). No `health_headers`, `health_port`, `health_body`, `health_passes`/`health_fails`, `unhealthy_latency`, `unhealthy_request_count`. | Med |
| reverse_proxy, transport | Partial | `tls_insecure_skip_verify`, `tls_server_name`, dial/response header/read/write timeouts, `keepalive` + idle conns, `versions` (`siteBlocks.ts:311-328`). No `tls_trust_pool`, `tls_client_auth`, `tls_timeout`, `max_conns_per_host`, `proxy_protocol`, `compression`. | Low |
| reverse_proxy, headers | Full | `header_up` set/add/delete, `header_down` set/add/delete/replace (#324, `siteBlocks.ts:418-420`, `RequestHeadersSection.tsx:150`). Values quoted (C4 fixed). No `header_up` replace. | Med |
| reverse_proxy, streaming | Full | `flush_interval`, `stream_timeout`, `stream_close_delay` (#325, `siteBlocks.ts:424-428`). | Low |
| reverse_proxy, dynamic upstreams | Full | `dynamic srv`, `a`, `multi` with their options (#326, `siteBlocks.ts:388-410`). | Low |
| reverse_proxy, handle_response / copy_response / buffers | Raw-only | Only the plugin's own upstream-error interception uses `handle_response` (`siteBlocks.ts:442-454`). | Low |
| file_server | Full | `root`, `browse` with template/sort/file_limit/reveal_symlinks, `index`, `hide`, `precompressed`, `disable_canonical_uris`, `status` (`siteBlocks.ts:680-719`, `types.ts:403-428`). No `pass_thru`, `etag_file_extensions`, `fs`. | Med |
| try_files / SPA fallback | Partial | SPA preset on static sites (`siteBlocks.ts:682`), free `try_files` on PHP sites (`siteBlocks.ts:729`, `FileServerOptionsFields.tsx:263`). No free `try_files` on static sites. The `file` matcher covers the rest. | Med |
| php_fastcgi | Full | `upstream`, `root`, `index`, `split`, `env` (quoted), `try_files`, `capture_stderr`, `resolve_root_symlink`, dial/read/write timeouts, paired with `file_server` (`siteBlocks.ts:727-749`). | High |
| redir | Full | Target + 301/302/307/308 or `html` (#338, `siteBlocks.ts:788`), "keep path and query" adds `{uri}` (`RedirectModeField.tsx:9-20`). | Med |
| respond | Full | Status, body, `close` (`siteBlocks.ts:772-786`). Body quoted, heredoc for newlines (`caddyfileDocument.ts:870-891`). | Low |
| rewrite / uri | Partial | strip_prefix, add_prefix, strip_suffix, `uri path_regexp`, `uri replace`, `uri query` ops, `method` (#332, `siteBlocks.ts:282-305`). Only one rewrite per site (`types.ts:592`). | Med |
| handle / handle_path / route | Full | `handle @m`, `handle_path` (several paths via a regex strip, C11 fixed), named routes `&(name)` + `invoke` (`siteBlocks.ts:1247`, `1321-1330`). `route` and nested handles in the Tree tab: show, edit matchers and directives, add, remove, reorder (#349 to #351, `siteTree.ts`, `treeMatchers.ts`). | Med |
| Matchers | Full | path, host, method, header, query, remote_ip, client_ip, `not`, `expression`, path_regexp, header_regexp, protocol, file, vars (`types.ts:64-90`, `siteBlocks.ts:42-91`). One `not` group, one regexp of each kind. No `vars_regexp`. | High |
| header (response) | Partial | set/add/delete; set is deferred (`>`) on proxied routes (`siteBlocks.ts:19-28`, `819`). No `?` default, no replace. | Low |
| encode | Full | Algorithms in order, `minimum_length`, `match` status/header (#335, `siteBlocks.ts:257-267`). Plain `encode` keeps Caddy's zstd-first default. | Low |
| basic_auth | Full | Realm and bcrypt/argon2id (#337, `siteBlocks.ts:270-279`). Password hashed with `caddy hash-password` on stdin (`caddy.ts:799-810`). | Med |
| forward_auth | Full | `uri`, `copy_headers` with `A>B` renaming, `header_up`, `trusted_proxies` (#336, `siteBlocks.ts:241-250`). JSON matches Caddy's adapter (C5 fixed, `caddyJsonModel.ts:193-231`). | High |
| TLS: internal CA | Full | Lifetime, renewal window, key type, protocols, ciphers, curves (`siteBlocks.ts:610-627`). | High |
| TLS: custom cert files | Full | `tls cert key` (`siteBlocks.ts:579-591`). | Med |
| TLS: client auth / mTLS | Partial | `mode` + `trust_pool file` (C14 fixed, `siteBlocks.ts:651-660`). No other pool sources, no `verifier`. | Low |
| TLS: DNS challenge | Full | Global `acme_dns` (#261) and per-site `tls { dns }` (#289), credentials in `/etc/caddy/dns.env` (`globalOptions.ts:304-318`, `siteBlocks.ts:597-598`). Needs a caddy-dns build; module detection warns when the provider is missing. | High |
| TLS: on-demand | Full | Per-site `tls { on_demand }` (C8 fixed, `siteBlocks.ts:577`), global `on_demand_tls { ask }`; interval/burst marked deprecated (`en.json:804`). | Low |
| TLS: per-site email/ca/key_type | Full | `tls <email> { ca …; key_type … }` (#341, `siteBlocks.ts:599-607`). No per-site `ca_root` or EAB. | Low |
| Access log | Full | Output, file, rotation, format, level, field filters, `log_skip` (#334, `globalOptions.ts:83-110`). | Med |
| Runtime log (global `log`) | Partial | Same fields plus `include`/`exclude` (`globalOptions.ts:102-103`). Only the default logger. | Low |
| request_body | Full | `max_size` (`siteBlocks.ts:769-771`). | Low |
| handle_errors | Partial | Code lists / 4xx / 5xx / all → respond / redir / static `{code}.html` (`siteBlocks.ts:513-538`). Exact upstream codes kept (C15 fixed), upstream interception is a toggle (C16 fixed). No proxy to an error service. | Med |
| templates | Full | `templates { mime root }` on static sites (#339, `siteBlocks.ts:686-696`). No `between`, not on proxied sites. | Low |
| import / snippets | Full | Snippets edited on the Settings tab, imported per site (#288, `snippets.ts`, `siteBlocks.ts:752-761`). Hand-written snippets listed read-only. Snippet arguments Raw-only. | Med |
| metrics | Full | Global `metrics` with `per_host` (#342), a dedicated site (`globalOptions.ts:735`, `792-818`). | Low |
| Global: ports, debug, grace, shutdown_delay | Full | `globalOptions.ts:675-679` | Low |
| Global: email, acme_ca, acme_ca_root, acme_eab | Full | `globalOptions.ts:680-688`. | Med |
| Global: admin | Full | `admin <addr> { origins enforce_origin }` or `admin off` (#330, `globalOptions.ts:722-730`). Moving it doesn't lock the plugin out (`caddy.ts:881-898`). | Low |
| Global: storage | Full | `file_system` root (`globalOptions.ts:701-705`). Other storage modules need plugins: Raw-only. | Low |
| Global: servers | Full | timeouts incl. `read_body_idle`, `max_header_size`, `protocols h1 h2`, `trusted_proxies` (+strict, headers), `proxy_protocol`, `keepalive_*`, `strict_sni_host`, `log_credentials`, `enable_full_duplex` (#328, `caddy.ts:914-975`, `globalOptions.ts:27-35`). HTTP/3 can only be turned off. No `h2c`, no other listener wrappers. | Med |
| Global: auto_https, local_certs, default_sni, key_type, cert_issuer, ocsp, preferred_chains, default_bind | Full | #329, `globalOptions.ts:706-721`. `cert_issuer` takes any issuer with a body. | Low |
| Global: order, persist_config, pki, events, cert_lifetime, renew_interval, ocsp_interval | Raw-only | Not in `KNOWN_GLOBAL_OPTION_KEYS` (`globalOptions.ts:279-283`). | Low |
| Directives map, vars, abort, error, intercept, acme_server, tracing, fs, log_append | Raw-only | — | Low |
| layer4, caddy-dns, other modules | Partial | Modules are detected with `caddy list-modules`, or probed over the Admin API (#343, `caddyModules.ts:1-10`). DNS providers are usable. layer4, rate limiting, caddy-security are only detected: Raw-only. | Low |

## Notes by area

Line numbers in this section are the original ones (`caddy.ts` before the split).

### Site addresses and binding
`buildExternalAddress` emits `http://[host]:port` when TLS is off and `[scheme://][host]:port`
when it's on (`src/api/caddy.ts:1111-1138`). Caddy docs: "By default, sites bind on all network
interfaces … use the bind directive or the default_bind global option" to restrict, and the host
in an address only affects matching on `Host`
([concepts](https://caddyserver.com/docs/caddyfile/concepts#addresses)). Several addresses per
block are allowed ("with spaces and commas", same source). Named servers use this
(`caddy.ts:3433-3435`), standalone entries can't.

Update: standalone entries take several names (#208) and a `bind` line (#323). An IP as host no
longer binds anything by itself; only `bind` restricts the listener, in the Caddyfile and in the
JSON push (`siteBlocks.ts:1098-1122`, `caddyJsonModel.ts:1587-1592`). `default_bind` is a global
option (#329).

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

Update: the three-way choice exists (`TlsModeField.tsx:9-30`). DNS providers are detected
(#343) and configured globally or per site, with credentials in an env file (#261, #289).

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

Update: `client_ip` exists (#286, `siteBlocks.ts:61-63`). A site using it is applied by reload,
because only Caddy's adapter puts the global `trusted_proxies` on the server (`siteEditing.ts:58-63`).

### Global options
The list is at [options](https://caddyserver.com/docs/caddyfile/options). The plugin knows 14 keys
(`caddy.ts:4336-4340`). `servers :PORT` blocks replace the global `servers` block for that port.
The plugin handles this by copying trusted_proxies/proxy_protocol into each per-port block
(`caddy.ts:3900-3907`). That matches the docs ("Can be specified more than once with different
`listener_address` values").

Update: the plugin knows 24 keys (`globalOptions.ts:279-283`).

## Correctness concerns

**C1. Editing an ACME site through the GUI turns it into an internal-CA site.**
**Status: fixed** in #279 (#246). A site has a certificate issuer, read from conf.d
(`caddyfileDocument.ts:278-294`): a public name without `tls internal` reads as `acme`. Automatic
HTTPS writes no issuer (`siteBlocks.ts:593-608`), and `patchRawBlock` writes `tls` back where it
stood (`siteBlocks.ts:932-936`, `960-970`).
A hand-written site like `app.example.com { reverse_proxy … }` is read as `tls: true`
(`serverHasTls`, `caddy.ts:2651-2660`; `parseConfTlsMap`, `caddy.ts:544-561`). On save,
`patchRawBlock` removes any top-level `tls` line (`caddy.ts:1564-1568`) and re-adds
`buildTlsCaddyLines`, which emits `tls internal` (`caddy.ts:1629`, `1317`). A header like
`app.example.com:443 {` counts as plugin format and is regenerated in full with the same result
(`caddy.ts:1674`). Unchecking TLS writes `http://` instead. Either way the site loses its
publicly trusted certificate without any warning. Caddy uses the public ACME issuer by default for
such names ([automatic-https](https://caddyserver.com/docs/automatic-https)).

**C2. PHP sites don't serve static files.** **Status: fixed** in #274 (#247): `file_server`
follows `php_fastcgi` (`siteBlocks.ts:722-749`).
The php route emits `root` + `php_fastcgi` and no
`file_server` (`caddy.ts:1405-1428`). Caddy: php_fastcgi "should almost always be paired with"
`root` and `file_server`. Its expansion rewrites existing non-PHP files to themselves and proxies
only `*.php` ([php_fastcgi](https://caddyserver.com/docs/caddyfile/directives/php_fastcgi)), so
requests for CSS/JS/images reach no handler.

**C3. The query matcher and the header-presence matcher write invalid syntax.**
**Status: fixed** in #272 (#250): presence is written as `*`, query as `param=value`
(`siteBlocks.ts:47-57`).
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

**C4. Values aren't quoted or escaped.** **Status: fixed** in #273 (#251): `caddyQuote` makes one
token of any value, with `\"`, backticks or a heredoc (`caddyfileDocument.ts:870-891`), and header,
respond and env lines use it (`siteBlocks.ts:23-28`, `775-779`, `737`).
- `header_up ${name} ${value}` and `header +${name} ${value}` are written unquoted
  (`caddy.ts:1053-1054`, `1400`). A value with a space becomes 3 arguments, which Caddy reads as a
  find/replace op, not a set
  ([headers/caddyfile.go L262-277](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/headers/caddyfile.go#L240-L295);
  syntax `[<value>|<find>] [<replace>]` in [header](https://caddyserver.com/docs/caddyfile/directives/header)).
- `respond "${body}"` (`caddy.ts:1377`, `1194`) and `header X "${value}"` (`caddy.ts:1401`)
  break on a `"` in the input, and a body with newlines needs a heredoc
  ([respond](https://caddyserver.com/docs/caddyfile/directives/respond)).

**C5. The instant-apply JSON for forward_auth differs from Caddy's own `forward_auth`.**
**Status: fixed** in #271 (#248): the JSON now deletes each copied header from the client request
and sets it from the auth response, and an `https://` auth URL gets a TLS transport
(`caddyJsonModel.ts:166-231`).
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

**C6. `unhealthy_status` alone does nothing, and the UI describes it wrongly.**
**Status: fixed** in #276 (#252): `unhealthy_status` and `max_fails` are only written with
`fail_duration`, and active checks exist (`siteBlocks.ts:371-383`, `LbRetrySection.tsx:121-123`).
The plugin writes
`unhealthy_status` without `fail_duration` (`caddy.ts:1041`). The UI says the codes "trigger
retrying a different upstream" (`en.json:301`, `types.ts:308-310`). Caddy: passive health checks
need `fail_duration`, and status-based retries need `lb_retry_match` with `{rp.status_code}`
([reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)).

**C7. The host field doesn't control binding the way the code says, and the two apply paths
disagree.** **Status: fixed** in #277 (#254) and `3fa13ad` (#365): an IP as host binds nothing in
either path, and the listener is restricted only by `bind`, which both paths build from one list
(`siteBlocks.ts:1098-1122`, `caddyJsonModel.ts:1587-1592`).
`ProxyEntry.externalHost` is documented as "hostname/IP for the external listener;
omit to bind all interfaces" (`types.ts:347-348`). The instant JSON binds `IP:port` when the host
is an IP (`caddy.ts:2490-2494`). The saved Caddyfile `192.168.1.5:8443 {` binds all interfaces
and only matches on `Host` ([concepts](https://caddyserver.com/docs/caddyfile/concepts#addresses)).
After a reload the port opens on every interface.

**C8. "Enable on-demand TLS" doesn't enable it.** **Status: fixed** in #280 (#253): a site turns
it on with `tls { on_demand }` (`siteBlocks.ts:576-577`), the global option says it only configures
the ask endpoint, and interval/burst carry a deprecation note (`en.json:742-743`, `804`).
Caddy: `on_demand_tls` "configures On-Demand TLS
where it is enabled, but does not enable it", and you turn it on with `tls { on_demand }`. Caddy
also says `interval`/`burst` "are NOT recommended. Remove them"
([options](https://caddyserver.com/docs/caddyfile/options)). The plugin writes only the global
option, with interval/burst (`caddy.ts:4587-4593`), and its help text promises certificates "at
connection time" and calls no rate limit "not recommended" (`en.json:528`, `534`).

**C9. The "Defaults" button for server timeouts uses values that aren't Caddy's defaults and are
too short.** **Status: fixed** in #275 (#249): both "Defaults" buttons clear the fields, so Caddy's
own defaults apply, and the placeholders show them (`ServerTimeoutsSection.tsx:60`, `106`;
`TransportSection.tsx:29`, `74`).
It sets read 5s, read_header 2s, write 10s, idle 5m, max header 1 MiB
(`src/components/ServerTimeoutsSection.tsx:25-32`). These are written as `read_body`/`write`
(`caddy.ts:3891-3894`). Caddy: `read_body` is "a hard limit on the whole upload", default none.
`write` default none. `read_header` default 1m. `max_header_size` default 16KiB
([options](https://caddyserver.com/docs/caddyfile/options)). With these values, any upload over 5 s
or download over 10 s fails. The transport "Defaults" (dial 10s, response header 30s,
`TransportSection.tsx:16`) also differ from Caddy's 3s/none, and 30s cuts off slow or long-polling
responses.

**C10. Regex rewrite means different things in the instant-apply JSON and after a reload.**
**Status: fixed** in #277 (#254): the Caddyfile now writes `uri path_regexp` (`siteBlocks.ts:301-304`).
JSON: `rewrite.path_regexp` does a substring replace on the path (`caddy.ts:967`). Caddyfile:
`@rw path_regexp rw <find>` + `rewrite @rw <replace>` replaces the **whole URI**
(`caddy.ts:989-990`). For a pattern like `old` → `new`, the JSON gives `/x/new/y` and the
Caddyfile gives `new`. `uri path_regexp <find> <replace>` matches the JSON behaviour
([uri](https://caddyserver.com/docs/caddyfile/directives/uri)).

**C11. handle_path with several paths.** **Status: fixed** in #311 (#255): several paths get a
named matcher and a `uri path_regexp` strip instead (`siteBlocks.ts:221-233`, `849-858`).
The plugin writes `handle_path /a/* /b/*`
(`caddy.ts:1469-1472`, `3470`), and the strip checkbox shows for any number of paths
(`AddPhpFastcgiDialog.tsx:279`). Caddy: "Only a single path matcher is accepted"
([handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)). The parser reads
only the first argument, then re-parses the segment, which rejects extra args on the first line
([rewrite/caddyfile.go L236-262](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/rewrite/caddyfile.go#L226-L262),
[directives.go L377-381](https://github.com/caddyserver/caddy/blob/master/caddyconfig/httpcaddyfile/directives.go#L374-L381)).
Expect a validation error, or at best only the first path working.

**C12. Response header set ops aren't deferred in the Caddyfile.** **Status: fixed** in #311
(#255): on proxied routes a set is written as `>Name` (`siteBlocks.ts:18-28`, `819`, `992`).
The JSON comment says the
Caddyfile adapter sets `deferred` automatically (`caddy.ts:2390-2397`). It does so only for delete
(`-`), default (`?`), `>`, or `defer`, not for a plain set
([headers/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/headers/caddyfile.go#L240-L295);
[header](https://caddyserver.com/docs/caddyfile/directives/header)). reverse_proxy then *adds* the
upstream's headers (`dst.Add`,
[reverseproxy.go L1525, L1879-1885](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/reverseproxy.go#L1879-L1885)).
After a reload, a header the upstream also sends (e.g. `X-Frame-Options`, `Cache-Control`)
appears twice. Emit `>Name value` or `defer` on proxied routes.

**C13. Basic-auth passwords go in argv.** **Status: fixed** in #311 (#255): the password goes on
stdin (`caddy.ts:799-810`).
`caddy hash-password --plaintext <pw>`
(`caddy.ts:3270-3276`). While the command runs, any local user can read the password from
`/proc/*/cmdline`. Feeding it on stdin avoids that.

**C14. `trusted_ca_cert_file` is deprecated.** **Status: fixed** in #311 (#255): the plugin writes
`trust_pool file <pem>` and still reads the old JSON form (`siteBlocks.ts:654-658`, `types.ts:36-42`).
It's emitted at `caddy.ts:1359`. Caddy logs "The
'trusted_ca_cert_file' field is deprecated. Use the 'trust_pool' field instead"
([connpolicy.go L708-709](https://github.com/caddyserver/caddy/blob/master/modules/caddytls/connpolicy.go#L708-L711)).
The documented form is `trust_pool file <pem>`
([tls](https://caddyserver.com/docs/caddyfile/directives/tls)).

**C15. 4xx/5xx error handlers change the status the client gets.** **Status: fixed** in #311
(#255): a class is re-raised with `error "upstream error" {rp.status_code}`, which keeps the code
(`siteBlocks.ts:438-451`).
Upstream errors are re-raised
with `error 400` / `error 500` (`caddy.ts:1073-1086`), so a 404 from the upstream reaches a "4xx"
handler as 400. The code comment says the status argument can't take a placeholder. That's true for
the one-argument form only. With two arguments, `error "<msg>" {rp.status_code}` stores the status
as a string and resolves it at runtime
([staticerror.go L61-108](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticerror.go#L54-L108)).
That keeps exact codes with one handler. Separately, `respond` inside `handle_errors` correctly
keeps the error status when none is given
([staticresp.go L226-242](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticresp.go#L226-L242)).

**C16. Error handlers on a proxy replace the application's own error responses.**
**Status: fixed** in #311 (#255): interception is a toggle, off for new handlers
(`types.ts:654-659`, `siteBlocks.ts:434-443`, `ErrorHandlersSection.tsx:228-229`).
Caddy's
`handle_errors` normally fires only for errors Caddy itself raises
([handle_errors](https://caddyserver.com/docs/caddyfile/directives/handle_errors)). The plugin also
intercepts upstream responses through `handle_response` (`caddy.ts:1073-1086`), so an app's JSON
404/409 or a 401 with `WWW-Authenticate` gets replaced by the configured page. This is a deliberate
design choice, but the UI should say so, for example with an "also intercept upstream errors" toggle.

**C17. php_fastcgi `env` values are written unquoted** (`caddy.ts:1424`). A value with spaces
gets split into extra arguments. **Status: fixed** in #273 (#251), `siteBlocks.ts:737`.

**C18. Editing a hand-written redirect or respond site adds a `reverse_proxy`.** **Status: open**
(new in this update). A block whose header isn't the plugin's `host:port` shape, such as
`old.example.com {`, is patched by `patchRawBlock` (`siteBlocks.ts:1034-1036`). Its last branch
has no case for `redirect` or `staticResponse` and always appends `buildReverseProxyLines`
(`siteBlocks.ts:988-995`). `redir` and `respond` aren't in the rewritten list
(`siteBlocks.ts:916`), so the old line also stays. Saving such a site through its dialog gives:

```
old.example.com {
	redir https://new.example.com{uri} 301
	reverse_proxy http://:0
}
```

The changed target is lost, and `reverse_proxy http://:0` either fails validation or proxies to
nothing.

**C19. Editing a hand-written site drops form changes and doubles error handlers.**
**Status: open** (new in this update). Same path as C18. `patchRawBlock` keeps `uri`/`rewrite`,
`request_body`, `log`, named matchers and `handle_errors` lines as they were, and writes none of
the form's values for them (`siteBlocks.ts:916`, `975-996`), while `proxyToBlock` writes all of
them (`siteBlocks.ts:846-880`). So a changed rewrite, body limit, access log or matcher on such a
site is silently not saved. Error handlers are re-emitted at the end (`siteBlocks.ts:996`), next to
the old `handle_errors` block that was kept, so each save adds another copy. Suggested fix: add
those directives (and `redir`, `respond`, `handle_errors`) to the rewritten list and emit them as
`buildRouteHandlerLines` does, or regenerate such blocks with `proxyToBlock` and keep only the
unknown lines.

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

Read for the 2026-11-26 update: `src/api/{siteBlocks,caddyJsonModel,globalOptions,caddyfileDocument,siteEditing,siteTree,treeMatchers,snippets,caddyModules,dnsChallenge,caddy,types}.ts`,
`src/api/caddyAdapt.test.ts`, `src/hooks/useProxies.ts`,
`src/components/{TlsModeField,RedirectModeField,RequestHeadersSection,ErrorHandlersSection,LbRetrySection,FileServerOptionsFields,RawBlocksBadge}.tsx`,
`src/i18n/locales/en.json`, and the closed issues and merged PRs #245 to #366.
