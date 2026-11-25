# 0001. The Caddyfile and JSON logic live in four pure modules

## Status

Accepted

## Context

`src/api/caddy.ts` had grown to 5,900 lines: the Caddyfile text editing, the global options, the per-site rendering, the Caddy JSON model and the code that talks to the admin API and the disk, all in one file. Nothing in it could be read, or tested, without the rest.

## Decision

The pure parts moved into four modules, each importing only the ones before it:

1. `caddyfileDocument`: where blocks start and end, reading a file, editing one block and keeping the rest as it was.
2. `globalOptions`: the global options block and the managed sections around it.
3. `siteBlocks`: a `ProxyEntry` rendered as a Caddyfile site, and written, edited or removed in a conf.d file.
4. `caddyJsonModel`: reading proxies out of a `CaddyConfig`, and merging or removing one.

`siteEditing` sits on top of them: `addSite`, `editSite` and `removeSite` write a site to conf.d (through `caddy.ts`, so a rejected config leaves every file as it was), decide whether Caddy is reloaded or pushed JSON, and return what changed. `useProxies` only applies that result to the lists the page shows.

None of the four modules touches the Host or the disk. `caddy.ts` keeps the admin API calls, the file I/O and the orchestration (`saveSiteConfig`, the global option sync, the config scan), and re-exports the modules so callers keep one import path.

## Consequences

- A change to how a site is written is a change to `siteBlocks`, tested with strings.
- The I/O that remains in `caddy.ts` goes through `applyConfigChange` and the base Host.
- New code imports from the module that owns the behaviour; the `caddy.ts` re-exports exist for existing callers.
