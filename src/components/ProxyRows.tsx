import {
  DataList,
  DataListCell,
  DataListItem,
  DataListItemCells,
  DataListItemRow,
  Label,
} from "@patternfly/react-core";
import { RawBlocksBadge, hasRawBlocks } from "./RawBlocksBadge";
import { useTranslation } from "react-i18next";
import { TlsBadge } from "./TlsBadge";
import { RowActions } from "./RowActions";
import { UpstreamStatusDot } from "./UpstreamStatusDot";
import { buildRouteUrl } from "./routeUrl";
import type { ProxyEntry, ServerDef } from "../api";
import type { ProbeStatus } from "../api/probe";
import { formatExternalHostPort } from "../api";

type EntryTypeColor = "blue" | "purple" | "teal" | "grey" | "green" | "red" | "orange";
interface EntryType { label: string; color: EntryTypeColor }
function entryType(proxy: ProxyEntry, t: (k: string) => string): EntryType {
  if (proxy.redirect) return { label: t("proxies.type_redirect"), color: "purple" };
  if (proxy.fileServer) return { label: t("proxies.type_static"), color: "green" };
  if (proxy.staticResponse) return { label: t("proxies.type_respond"), color: "orange" };
  if (proxy.phpFastcgi) return { label: t("proxies.type_php"), color: "teal" };
  return { label: t("proxies.type_proxy"), color: "blue" };
}

/**
 * The badges next to a site's address (#259): TLS issuer when it isn't plain HTTP, and the
 * settings worth knowing at a glance. Nothing at all when there's nothing to say.
 */
export function SiteBadges({ proxy }: { proxy: ProxyEntry }) {
  const { t } = useTranslation();
  const chips: { label: string; color: EntryTypeColor }[] = [];
  if (proxy.redirect) {
    chips.push({ label: proxy.redirect.html ? "html" : String(proxy.redirect.code), color: "purple" });
  }
  if (proxy.staticResponse?.close) {
    chips.push({ label: t("proxies.indicator_close"), color: "grey" });
  }
  if (!proxy.fileServer && !proxy.redirect && proxy.tlsSkipVerify) chips.push({ label: t("proxies.tls_skip_verify"), color: "orange" });
  if (proxy.rewrite) chips.push({ label: t(`rewrite.type_${proxy.rewrite.type}`), color: "teal" });
  if (proxy.fileServer?.browse) chips.push({ label: t("proxies.indicator_browse"), color: "teal" });
  if (proxy.compress) chips.push({ label: t("proxies.indicator_compress"), color: "teal" });
  if (proxy.basicAuth?.length) chips.push({ label: t("proxies.indicator_auth"), color: "red" });
  if (proxy.forwardAuth) chips.push({ label: t("forward_auth.indicator"), color: "purple" });
  if (proxy.dialTimeout ?? proxy.responseHeaderTimeout) chips.push({ label: t("proxies.indicator_timeouts"), color: "grey" });
  if (proxy.accessLog) chips.push({ label: t("access_log.indicator"), color: "teal" });
  if (proxy.serverReadTimeout ?? proxy.serverReadHeaderTimeout ?? proxy.serverWriteTimeout ?? proxy.serverIdleTimeout ?? proxy.maxHeaderBytes ?? proxy.requestBodyMaxSize) chips.push({ label: t("proxies.indicator_limits"), color: "grey" });
  if (proxy.extraUpstreams?.length) chips.push({ label: t("proxies.indicator_lb"), color: "blue" });
  if (proxy.mtls) chips.push({ label: t("tls_policy.indicator_mtls"), color: "orange" });
  if (proxy.tlsAdvanced) chips.push({ label: t("tls_policy.indicator_advanced"), color: "grey" });
  if (proxy.matchers) chips.push({ label: t("proxies.indicator_matcher"), color: "teal" });
  if (proxy.isNamedRoute) chips.push({ label: t("proxies.indicator_named_route"), color: "purple" });
  for (const name of proxy.imports ?? []) chips.push({ label: name, color: "blue" });
  const showTls = proxy.tls && !proxy.redirect;
  if (!showTls && chips.length === 0 && !hasRawBlocks(proxy)) return null;
  return (
    <span style={{ display: "inline-flex", flexShrink: 0, gap: "0.2rem", flexWrap: "nowrap", verticalAlign: "middle" }}>
      {showTls && <TlsBadge proxy={proxy} />}
      {chips.map(c => (
        <Label key={c.label} isCompact color={c.color} variant="outline">{c.label}</Label>
      ))}
      <RawBlocksBadge proxy={proxy} />
    </span>
  );
}

/** Cells stay one line high (#259); long content is cut with an ellipsis. */
const ONE_LINE = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

/**
 * The address cell: a long address is the part that gets cut (its full text in the link's
 * title), never the badges after it.
 */
const ADDRESS_CELL = { display: "flex", alignItems: "center", gap: "0.35rem", minWidth: 0, overflow: "hidden" } as const;

/** What the list shows as a site's address: host(s) and port, plus the first path matcher. */
function siteAddress(proxy: ProxyEntry): string {
  const path = proxy.matchers?.path?.[0];
  return formatExternalHostPort(proxy) + (path ? path.replace(/\*$/, "…") : "");
}

function HeaderRow() {
  const { t } = useTranslation();
  return (
    <DataListItem aria-labelledby="proxy-list-header" style={{ background: "var(--pf-v6-global--BackgroundColor--200)", color: "var(--pf-v6-global--Color--100)" }}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="label" width={2}><strong>{t("proxies.col_label")}</strong></DataListCell>,
            <DataListCell key="type" width={1}><strong>{t("proxies.col_type")}</strong></DataListCell>,
            <DataListCell key="port" width={4}><strong>{t("proxies.col_address")}</strong></DataListCell>,
            <DataListCell key="target" width={3}><strong>{t("proxies.col_target")}</strong></DataListCell>,
            <DataListCell key="actions" width={1} style={{ textAlign: "end" }}><strong>{t("proxies.col_actions")}</strong></DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

function ProxyRow({ proxy, onEdit, onDelete, onDuplicate, probeStatuses, servers }: {
  proxy: ProxyEntry;
  onEdit: (p: ProxyEntry) => void;
  onDelete: (p: ProxyEntry) => void;
  onDuplicate: (p: ProxyEntry) => void;
  probeStatuses: Map<string, ProbeStatus>;
  servers: ServerDef[];
}) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = buildRouteUrl(proto, proxy.externalPort, proxy);
  const serverName = proxy.namedServerKey
    ? (servers.find(s => s.key === proxy.namedServerKey)?.name ?? proxy.namedServerKey)
    : null;
  const address = siteAddress(proxy);

  return (
    <DataListItem aria-labelledby={`proxy-${proxy.id}`}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="label" width={2} style={ONE_LINE}>
              {proxy.label
                ? <strong style={{ fontSize: "1.05em" }}>{proxy.label}</strong>
                : <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>}
            </DataListCell>,
            <DataListCell key="type" width={1}>
              {(() => { const et = entryType(proxy, t); return <Label color={et.color} isCompact>{et.label}</Label>; })()}
            </DataListCell>,
            <DataListCell key="port" width={4} style={ADDRESS_CELL}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                id={`proxy-${proxy.id}`}
                title={address}
                style={{ ...ONE_LINE, flex: "0 1 auto", minWidth: "8ch", fontFamily: "monospace", fontWeight: "bold" }}
              >
                {address}
              </a>
              {serverName && (
                <Label
                  isCompact
                  color="green"
                  variant="outline"
                  style={{ flexShrink: 0, fontSize: "0.75em" }}
                >
                  {serverName}
                </Label>
              )}
              <SiteBadges proxy={proxy} />
            </DataListCell>,
            <DataListCell key="target" width={3} style={ONE_LINE}>
              {proxy.redirect ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.redirect.to}</code>
              ) : proxy.staticResponse ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.staticResponse.statusCode}{proxy.staticResponse.body ? ` "${proxy.staticResponse.body.slice(0, 30)}${proxy.staticResponse.body.length > 30 ? "…" : ""}"` : ""}</code>
              ) : proxy.fileServer ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.fileServer.root}</code>
              ) : proxy.phpFastcgi ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.phpFastcgi.upstream}</code>
              ) : (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "nowrap" }}>
                  {(() => {
                    const primaryKey = `${proxy.targetHost}:${proxy.targetPort}`;
                    const primaryStatus = probeStatuses.get(primaryKey);
                    const primaryAddr = `${proxy.targetScheme}://${proxy.targetHost}:${proxy.targetPort}`;
                    return (
                      <>
                        {primaryStatus !== undefined && (
                          <UpstreamStatusDot status={primaryStatus} address={primaryAddr} />
                        )}
                        <code style={{ fontSize: "0.85em" }}>{primaryAddr}</code>
                        {(proxy.extraUpstreams ?? []).map(u => {
                          const key = `${u.host}:${u.port}`;
                          const status = probeStatuses.get(key);
                          const addr = `${proxy.targetScheme}://${u.host}:${u.port}`;
                          return (
                            <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                              {status !== undefined && <UpstreamStatusDot status={status} address={addr} />}
                              <code style={{ fontSize: "0.85em", color: "var(--pf-t--global--text--color--subtle)" }}>{addr}</code>
                            </span>
                          );
                        })}
                      </>
                    );
                  })()}
                </span>
              )}
            </DataListCell>,
            <DataListCell key="actions" width={1} style={{ textAlign: "end" }}>
              <RowActions onEdit={() => onEdit(proxy)} onDuplicate={() => onDuplicate(proxy)} onDelete={() => onDelete(proxy)} />
            </DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

interface RowsProps {
  proxies: ProxyEntry[];
  /** Below PatternFly's md breakpoint (#258): no column header, each site a two-line card. */
  compact: boolean;
  onEdit: (p: ProxyEntry) => void;
  onDelete: (p: ProxyEntry) => void;
  onDuplicate: (p: ProxyEntry) => void;
  probeStatuses: Map<string, ProbeStatus>;
  servers: ServerDef[];
}

/**
 * A site at phone width (#258): label and badges on the first line, the address on the second,
 * Edit and the row kebab on the right. The health dot of the primary upstream stays.
 */
function CompactProxyRow({ proxy, onEdit, onDelete, onDuplicate, probeStatuses, servers }: Omit<RowsProps, "proxies" | "compact"> & { proxy: ProxyEntry }) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = buildRouteUrl(proto, proxy.externalPort, proxy);
  const serverName = proxy.namedServerKey
    ? (servers.find(s => s.key === proxy.namedServerKey)?.name ?? proxy.namedServerKey)
    : null;
  const address = siteAddress(proxy);
  const et = entryType(proxy, t);
  const isProxy = !proxy.redirect && !proxy.staticResponse && !proxy.fileServer && !proxy.phpFastcgi;
  const status = isProxy ? probeStatuses.get(`${proxy.targetHost}:${proxy.targetPort}`) : undefined;
  const line = { ...ONE_LINE, display: "flex", alignItems: "center", gap: "0.35rem" } as const;

  return (
    <DataListItem aria-labelledby={`proxy-${proxy.id}`}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="site">
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <div style={line}>
                    {proxy.label ? <strong>{proxy.label}</strong> : null}
                    <Label color={et.color} isCompact>{et.label}</Label>
                    {serverName && <Label isCompact color="green" variant="outline">{serverName}</Label>}
                    <SiteBadges proxy={proxy} />
                  </div>
                  <div style={line}>
                    {status !== undefined && (
                      <UpstreamStatusDot status={status} address={`${proxy.targetScheme}://${proxy.targetHost}:${proxy.targetPort}`} />
                    )}
                    <a href={url} target="_blank" rel="noopener noreferrer" id={`proxy-${proxy.id}`} title={address} style={{ ...ONE_LINE, fontFamily: "monospace", fontWeight: "bold" }}>
                      {address}
                    </a>
                  </div>
                </div>
                <div style={{ flex: "0 0 auto" }}>
                  <RowActions onEdit={() => onEdit(proxy)} onDuplicate={() => onDuplicate(proxy)} onDelete={() => onDelete(proxy)} />
                </div>
              </div>
            </DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

/** The list layout of the sites: a table-like DataList, or compact cards at phone width (#258). */
export function ProxyRows({ proxies, compact, ...rowProps }: RowsProps) {
  const { t } = useTranslation();
  return (
    <DataList aria-label={t("proxies.title")} isCompact>
      {!compact && <HeaderRow />}
      {proxies.map(proxy => compact
        ? <CompactProxyRow key={proxy.id} proxy={proxy} {...rowProps} />
        : <ProxyRow key={proxy.id} proxy={proxy} {...rowProps} />)}
    </DataList>
  );
}
