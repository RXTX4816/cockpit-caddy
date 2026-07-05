import type React from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataList,
  DataListCell,
  DataListItem,
  DataListItemCells,
  DataListItemRow,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  Label,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ProxyEntry, RouteMatch, ServerDef } from "../api";
import { UpstreamStatusDot } from "./UpstreamStatusDot";
import { parseListenPort } from "./AddServerDialog";
import { buildRouteUrl } from "./routeUrl";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tlsVersion(v: string): string {
  return v === "tls1.2" ? "TLS 1.2" : v === "tls1.3" ? "TLS 1.3" : v;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function MatcherCell({ matchers }: { matchers?: RouteMatch }) {
  const { t } = useTranslation();
  if (!matchers || (
    !matchers.path?.length && !matchers.host?.length &&
    !matchers.method?.length && !matchers.header &&
    !matchers.query && !matchers.remote_ip
  )) {
    return <span style={{ color: "var(--pf-v6-global--Color--200)", fontStyle: "italic" }}>{t("servers.col_catch_all")}</span>;
  }
  const chips: React.ReactNode[] = [];
  matchers.path?.forEach((p, i) => chips.push(
    <code key={`p${i}`} style={{ fontSize: "0.82em", background: "var(--pf-t--global--background--color--secondary--default)", padding: "0.1rem 0.3rem", borderRadius: "3px" }}>{p}</code>
  ));
  matchers.host?.forEach((h, i) => chips.push(
    <Label key={`h${i}`} isCompact color="purple" variant="outline">{h}</Label>
  ));
  matchers.method?.forEach((m, i) => chips.push(
    <Label key={`m${i}`} isCompact color="orange" variant="outline">{m}</Label>
  ));
  if (matchers.header) chips.push(<Label key="hdr" isCompact color="teal" variant="outline">header</Label>);
  if (matchers.query) chips.push(<Label key="qry" isCompact color="teal" variant="outline">query</Label>);
  if (matchers.remote_ip) chips.push(<Label key="ip" isCompact color="grey" variant="outline">IP</Label>);
  return (
    <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", alignItems: "center" }}>
      {chips}
    </div>
  );
}

type EntryTypeColor = "blue" | "purple" | "teal" | "grey" | "green" | "red" | "orange";
function routeTypeLabel(proxy: ProxyEntry, t: (k: string) => string): { label: string; color: EntryTypeColor } {
  if (proxy.redirect) return { label: t("proxies.type_redirect"), color: "purple" };
  if (proxy.fileServer) return { label: t("proxies.type_static"), color: "green" };
  if (proxy.staticResponse) return { label: t("proxies.type_respond"), color: "orange" };
  return { label: t("proxies.type_proxy"), color: "blue" };
}

function FlagChips({ proxy, t }: { proxy: ProxyEntry; t: (k: string) => string }) {
  const chips: { label: string; color: EntryTypeColor }[] = [];
  if (proxy.redirect) chips.push({ label: String(proxy.redirect.code), color: "purple" });
  if (proxy.staticResponse?.close) chips.push({ label: t("proxies.indicator_close"), color: "grey" });
  if (proxy.rewrite) chips.push({ label: t(`rewrite.type_${proxy.rewrite.type}`), color: "teal" });
  if (proxy.fileServer?.browse) chips.push({ label: "browse", color: "teal" });
  if (proxy.compress) chips.push({ label: t("proxies.indicator_compress"), color: "teal" });
  if (proxy.basicAuth?.length) chips.push({ label: t("proxies.indicator_auth"), color: "red" });
  if (proxy.dialTimeout ?? proxy.responseHeaderTimeout) chips.push({ label: t("proxies.indicator_timeouts"), color: "grey" });
  if (proxy.accessLog) chips.push({ label: t("access_log.indicator"), color: "teal" });
  if (proxy.forwardAuth) chips.push({ label: t("forward_auth.indicator"), color: "purple" });
  if (proxy.mtls) chips.push({ label: t("tls_policy.indicator_mtls"), color: "orange" });
  if (proxy.handlePath) chips.push({ label: "strip prefix", color: "teal" });
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: "0.2rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
      {chips.map(c => <Label key={c.label} isCompact color={c.color} variant="outline">{c.label}</Label>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route row
// ---------------------------------------------------------------------------

function ServerRouteRow({ proxy, serverTls, serverPort, onEdit, onDelete, onDuplicate, probeStatuses }: {
  proxy: ProxyEntry;
  serverTls: boolean;
  serverPort: number;
  onEdit: (p: ProxyEntry) => void;
  onDelete: (p: ProxyEntry) => void;
  onDuplicate: (p: ProxyEntry) => void;
  probeStatuses: Map<string, import("../api/probe").ProbeStatus>;
}) {
  const { t } = useTranslation();
  const et = routeTypeLabel(proxy, t);
  const proto = serverTls ? "https" : "http";
  const routeUrl = buildRouteUrl(proto, serverPort, proxy);

  const targetCell = proxy.redirect ? (
    <code style={{ fontSize: "0.85em" }}>{proxy.redirect.to}</code>
  ) : proxy.staticResponse ? (
    <code style={{ fontSize: "0.85em" }}>
      {proxy.staticResponse.statusCode}
      {proxy.staticResponse.body ? ` "${proxy.staticResponse.body.slice(0, 40)}${proxy.staticResponse.body.length > 40 ? "…" : ""}"` : ""}
    </code>
  ) : proxy.fileServer ? (
    <code style={{ fontSize: "0.85em" }}>{proxy.fileServer.root}</code>
  ) : (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
      {(() => {
        const key = `${proxy.targetHost}:${proxy.targetPort}`;
        const status = probeStatuses.get(key);
        const addr = `${proxy.targetScheme}://${proxy.targetHost}:${proxy.targetPort}`;
        return (
          <>
            {status !== undefined && <UpstreamStatusDot status={status} address={addr} />}
            <code style={{ fontSize: "0.85em" }}>{addr}</code>
            {(proxy.extraUpstreams ?? []).map(u => {
              const uKey = `${u.host}:${u.port}`;
              const uStatus = probeStatuses.get(uKey);
              const uAddr = `${proxy.targetScheme}://${u.host}:${u.port}`;
              return (
                <span key={uKey} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                  {uStatus !== undefined && <UpstreamStatusDot status={uStatus} address={uAddr} />}
                  <code style={{ fontSize: "0.85em", color: "var(--pf-t--global--text--color--subtle)" }}>{uAddr}</code>
                </span>
              );
            })}
          </>
        );
      })()}
    </span>
  );

  return (
    <DataListItem aria-labelledby={`srv-route-${proxy.id}`}>
      <DataListItemRow>
        <DataListItemCells dataListCells={[
          <DataListCell key="matcher" width={2}>
            <MatcherCell matchers={proxy.matchers} />
          </DataListCell>,
          <DataListCell key="label" width={2}>
            <span id={`srv-route-${proxy.id}`}>
              {proxy.label
                ? <strong>{proxy.label}</strong>
                : <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>}
            </span>
            <FlagChips proxy={proxy} t={t} />
          </DataListCell>,
          <DataListCell key="type" width={1}>
            <Label color={et.color} isCompact>{et.label}</Label>
          </DataListCell>,
          <DataListCell key="target" width={3}>
            {targetCell}
          </DataListCell>,
          <DataListCell key="port" width={1}>
            <a
              href={routeUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: "monospace", fontSize: "0.9em" }}
              title={routeUrl}
            >
              :{serverPort}{proxy.matchers?.path?.[0] ? proxy.matchers.path[0].replace(/\*$/, "…") : "/"}
            </a>
          </DataListCell>,
          <DataListCell key="actions" width={1}>
            <Button variant="plain" size="sm" onClick={() => onEdit(proxy)}>{t("common.edit")}</Button>
            {" "}
            <Button variant="plain" size="sm" onClick={() => onDuplicate(proxy)}>{t("common.duplicate")}</Button>
            {" "}
            <Button variant="plain" size="sm" isDanger onClick={() => onDelete(proxy)}>{t("common.delete")}</Button>
          </DataListCell>,
        ]} />
      </DataListItemRow>
    </DataListItem>
  );
}

// ---------------------------------------------------------------------------
// Server info card
// ---------------------------------------------------------------------------

function ServerInfoCard({ server, onEdit, onDelete }: {
  server: ServerDef;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const adv = server.tlsAdvanced;
  const hasTimeouts = !!(
    server.serverReadTimeout || server.serverReadHeaderTimeout ||
    server.serverWriteTimeout || server.serverIdleTimeout
  );

  return (
    <Card style={{ border: "1px solid var(--pf-t--global--border--color--default)" }}>
      <CardHeader
        actions={{
          actions: (
            <>
              <Button variant="secondary" size="sm" onClick={onEdit}>{t("servers.edit_server")}</Button>
              {" "}
              <Button variant="plain" size="sm" isDanger onClick={onDelete}>{t("servers.delete_server")}</Button>
            </>
          ),
        }}
      >
        <CardTitle>
          <span style={{ fontSize: "1.15em", fontWeight: 600 }}>{server.name}</span>
          <code style={{ marginLeft: "0.6rem", fontSize: "0.8em", color: "var(--pf-t--global--text--color--subtle)", fontWeight: 400 }}>
            {server.key}
          </code>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <DescriptionList isHorizontal columnModifier={{ default: "2Col" }} style={{ rowGap: "0.6rem" }}>

          <DescriptionListGroup>
            <DescriptionListTerm>{t("servers.field_listen")}</DescriptionListTerm>
            <DescriptionListDescription>
              {server.listenAddresses.length > 0 ? (
                <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                  {server.listenAddresses.map(a => {
                    const portMatch = a.match(/:(\d+)$/);
                    if (!portMatch) return (
                      <Label key={a} isCompact color="blue" variant="outline" style={{ fontFamily: "monospace" }}>{a}</Label>
                    );
                    const proto = server.tls ? "https" : "http";
                    const url = `${proto}://${window.location.hostname}:${portMatch[1]}/`;
                    return (
                      <a key={a} href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                        <Label isCompact color="blue" variant="outline" style={{ fontFamily: "monospace", cursor: "pointer" }}>{a} ↗</Label>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>TLS</DescriptionListTerm>
            <DescriptionListDescription>
              {server.tls
                ? <Label isCompact color="blue" variant="outline">{t("servers.detail_tls_enabled")}</Label>
                : <span style={{ color: "var(--pf-v6-global--Color--200)" }}>{t("servers.detail_tls_disabled")}</span>}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {adv?.protocolMin || adv?.protocolMax ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_tls_protocol")}</DescriptionListTerm>
              <DescriptionListDescription>
                {adv.protocolMin && adv.protocolMax
                  ? `${tlsVersion(adv.protocolMin)} – ${tlsVersion(adv.protocolMax)}`
                  : adv.protocolMin ? `≥ ${tlsVersion(adv.protocolMin)}`
                  : `≤ ${tlsVersion(adv.protocolMax!)}`}
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {adv?.cipherSuites?.length ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_cipher_suites")}</DescriptionListTerm>
              <DescriptionListDescription>
                <span style={{ color: "var(--pf-t--global--text--color--subtle)", fontSize: "0.88em" }}>
                  {adv.cipherSuites.join(", ")}
                </span>
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {adv?.curves?.length ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_curves")}</DescriptionListTerm>
              <DescriptionListDescription>
                <span style={{ fontSize: "0.88em" }}>{adv.curves.join(", ")}</span>
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {server.mtls ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_mtls")}</DescriptionListTerm>
              <DescriptionListDescription>
                <Label isCompact color="orange" variant="outline">{server.mtls.mode}</Label>
                {server.mtls.trustedCaFile && (
                  <code style={{ marginLeft: "0.4rem", fontSize: "0.82em" }}>{server.mtls.trustedCaFile}</code>
                )}
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {hasTimeouts ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_timeouts")}</DescriptionListTerm>
              <DescriptionListDescription>
                <span style={{ fontSize: "0.88em", color: "var(--pf-t--global--text--color--subtle)" }}>
                  {[
                    server.serverReadTimeout && `read ${server.serverReadTimeout}`,
                    server.serverReadHeaderTimeout && `header ${server.serverReadHeaderTimeout}`,
                    server.serverWriteTimeout && `write ${server.serverWriteTimeout}`,
                    server.serverIdleTimeout && `idle ${server.serverIdleTimeout}`,
                  ].filter(Boolean).join(" · ")}
                </span>
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {server.maxHeaderBytes != null ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_max_header")}</DescriptionListTerm>
              <DescriptionListDescription>
                <code style={{ fontSize: "0.88em" }}>{formatBytes(server.maxHeaderBytes)}</code>
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {server.accessLog ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_access_log")}</DescriptionListTerm>
              <DescriptionListDescription>
                <Label isCompact color="teal" variant="outline">{server.accessLog.output}</Label>
                {server.accessLog.filePath && (
                  <code style={{ marginLeft: "0.4rem", fontSize: "0.82em" }}>{server.accessLog.filePath}</code>
                )}
                {server.accessLog.format && (
                  <span style={{ marginLeft: "0.4rem", fontSize: "0.82em", color: "var(--pf-t--global--text--color--subtle)" }}>
                    {server.accessLog.format}
                  </span>
                )}
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

          {server.errorHandlers?.length ? (
            <DescriptionListGroup>
              <DescriptionListTerm>{t("servers.field_error_handlers")}</DescriptionListTerm>
              <DescriptionListDescription>
                <span style={{ fontSize: "0.88em" }}>
                  {t("servers.detail_error_handlers", { count: server.errorHandlers.length })}
                </span>
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}

        </DescriptionList>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface Props {
  server: ServerDef;
  routes: ProxyEntry[];
  onEditServer: () => void;
  onDeleteServer: () => void;
  onEdit: (p: ProxyEntry) => void;
  onDelete: (p: ProxyEntry) => void;
  onDuplicate: (p: ProxyEntry) => void;
  onAddProxy: () => void;
  probeStatuses: Map<string, import("../api/probe").ProbeStatus>;
}

export function ServerDetailPanel({
  server, routes,
  onEditServer, onDeleteServer,
  onEdit, onDelete, onDuplicate,
  onAddProxy,
  probeStatuses,
}: Props) {
  const { t } = useTranslation();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--pf-v6-global--spacer--lg)" }}>
      <ServerInfoCard server={server} onEdit={onEditServer} onDelete={onDeleteServer} />

      {/* Routes section */}
      <div>
        <div style={{ marginBottom: "0.5rem" }}>
          <span style={{ fontWeight: 600, fontSize: "1em" }}>
            {t("servers.routes_section")}
            {routes.length > 0 && (
              <span style={{ marginLeft: "0.4rem", color: "var(--pf-t--global--text--color--subtle)", fontWeight: 400 }}>
                ({routes.length})
              </span>
            )}
          </span>
        </div>

        {routes.length === 0 ? (
          <EmptyState>
            <EmptyStateBody>{t("servers.no_routes")}</EmptyStateBody>
            <EmptyStateFooter>
              <Button variant="primary" onClick={onAddProxy}>{t("proxies.add_proxy")}</Button>
            </EmptyStateFooter>
          </EmptyState>
        ) : (
          <DataList aria-label={t("servers.routes_section")} isCompact>
            {/* Header row */}
            <DataListItem aria-labelledby="srv-route-header" style={{ background: "var(--pf-v6-global--BackgroundColor--200)" }}>
              <DataListItemRow>
                <DataListItemCells dataListCells={[
                  <DataListCell key="matcher" width={2}><strong>{t("servers.col_matcher")}</strong></DataListCell>,
                  <DataListCell key="label" width={2}><strong>{t("proxies.col_label")}</strong></DataListCell>,
                  <DataListCell key="type" width={1}><strong>{t("proxies.col_type")}</strong></DataListCell>,
                  <DataListCell key="target" width={3}><strong>{t("proxies.col_target")}</strong></DataListCell>,
                  <DataListCell key="port" width={1}><strong>{t("proxies.col_port")}</strong></DataListCell>,
                  <DataListCell key="actions" width={1}><strong>{t("proxies.col_actions")}</strong></DataListCell>,
                ]} />
              </DataListItemRow>
            </DataListItem>

            {routes.map(route => (
              <ServerRouteRow
                key={route.id}
                proxy={route}
                serverTls={server.tls}
                serverPort={parseListenPort(server.listenAddresses[0] ?? ":443")}
                onEdit={onEdit}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                probeStatuses={probeStatuses}
              />
            ))}
          </DataList>
        )}
      </div>
    </div>
  );
}
