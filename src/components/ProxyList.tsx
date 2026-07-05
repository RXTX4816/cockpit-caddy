import { useState } from "react";
import {
  Alert,
  AlertActionCloseButton,
  Button,
  Content,
  DataList,
  DataListCell,
  DataListItem,
  DataListItemCells,
  DataListItemRow,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  Gallery,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Stack,
  StackItem,
  Switch,
  Tab,
  Tabs,
  TabTitleText,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from "@patternfly/react-core";
import { ExternalLinkAltIcon, ListAltIcon, ThIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";
import {
  useToast,
  CollapsibleSearch,
  LayoutSelector,
  type LayoutOption,
} from "@rxtx4816/cockpit-plugin-base-react/components";
import { useLayout, useLocalStorage } from "@rxtx4816/cockpit-plugin-base-react";
import { AddProxyDialog } from "./AddProxyDialog";
import { AddRedirectDialog } from "./AddRedirectDialog";
import { AddStaticDialog } from "./AddStaticDialog";
import { AddRespondDialog } from "./AddRespondDialog";
import { EditProxyDialog } from "./EditProxyDialog";
import { EditRedirectDialog } from "./EditRedirectDialog";
import { EditStaticDialog } from "./EditStaticDialog";
import { EditRespondDialog } from "./EditRespondDialog";
import { AddServerDialog } from "./AddServerDialog";
import { EditServerDialog } from "./EditServerDialog";
import { ServerDetailPanel } from "./ServerDetailPanel";
import { ProxyCard } from "./ProxyCard";
import { useProxies } from "../hooks/useProxies";
import { useUpstreamProbe } from "../hooks/useUpstreamProbe";
import { UpstreamStatusDot } from "./UpstreamStatusDot";
import { buildRouteUrl } from "./routeUrl";
import type { ProxyEntry, ServerDef } from "../api";
import { accessLogConfigToValues } from "./AccessLogSection";
import { tlsConfigToValues } from "./TlsSection";

type ProxyLayout = "list" | "card";
const PROXY_LAYOUTS: LayoutOption<ProxyLayout>[] = [
  { key: "list", icon: <ListAltIcon />, label: "List" },
  { key: "card", icon: <ThIcon />,      label: "Cards" },
];

interface ApiError { message: string; search: string; action: "add" | "edit" }

function extractLogsSearch(message: string): string {
  const code = message.match(/\b(?:HTTP|status|code)[/ :]+([45]\d{2})\b/i)?.[1];
  return code ? `"status_code":${code}` : message.substring(0, 60);
}

// Pending action that the gate modal is guarding
type GateAction = "add" | { type: "edit"; proxy: ProxyEntry } | { type: "delete"; proxy: ProxyEntry };

type EntryTypeColor = "blue" | "purple" | "teal" | "grey" | "green" | "red" | "orange";
interface EntryType { label: string; color: EntryTypeColor }
function entryType(proxy: ProxyEntry, t: (k: string) => string): EntryType {
  if (proxy.redirect) return { label: t("proxies.type_redirect"), color: "purple" };
  if (proxy.fileServer) return { label: t("proxies.type_static"), color: "green" };
  if (proxy.staticResponse) return { label: t("proxies.type_respond"), color: "orange" };
  return { label: t("proxies.type_proxy"), color: "blue" };
}

function FlagChips({ proxy, t }: { proxy: ProxyEntry; t: (k: string) => string }) {
  const chips: { label: string; color: EntryTypeColor }[] = [];
  if (proxy.redirect) {
    chips.push({ label: String(proxy.redirect.code), color: "purple" });
  }
  if (proxy.staticResponse?.close) {
    chips.push({ label: t("proxies.indicator_close"), color: "grey" });
  }
  if (proxy.rewrite) chips.push({ label: t(`rewrite.type_${proxy.rewrite.type}`), color: "teal" });
  if (proxy.fileServer?.browse) chips.push({ label: "browse", color: "teal" });
  if (proxy.compress) chips.push({ label: t("proxies.indicator_compress"), color: "teal" });
  if (proxy.basicAuth?.length) chips.push({ label: t("proxies.indicator_auth"), color: "red" });
  if (proxy.dialTimeout ?? proxy.responseHeaderTimeout) chips.push({ label: t("proxies.indicator_timeouts"), color: "grey" });
  if (proxy.accessLog) chips.push({ label: t("access_log.indicator"), color: "teal" });
  if (proxy.serverReadTimeout ?? proxy.serverReadHeaderTimeout ?? proxy.serverWriteTimeout ?? proxy.serverIdleTimeout ?? proxy.maxHeaderBytes) chips.push({ label: t("proxies.indicator_limits"), color: "grey" });
  if (proxy.extraUpstreams?.length) chips.push({ label: t("proxies.indicator_lb"), color: "blue" });
  if (proxy.forwardAuth) chips.push({ label: t("forward_auth.indicator"), color: "purple" });
  if (proxy.mtls) chips.push({ label: t("tls_policy.indicator_mtls"), color: "orange" });
  if (proxy.tlsAdvanced) chips.push({ label: t("tls_policy.indicator_advanced"), color: "grey" });
  if (proxy.matchers) chips.push({ label: "matcher", color: "teal" });
  if (chips.length === 0) return <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>;
  return (
    <div style={{ display: "flex", gap: "0.2rem", flexWrap: "wrap" }}>
      {chips.map(c => (
        <Label key={c.label} isCompact color={c.color} variant="outline">{c.label}</Label>
      ))}
    </div>
  );
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
            <DataListCell key="port" width={1}><strong>{t("proxies.col_port")}</strong></DataListCell>,
            <DataListCell key="target" width={2}><strong>{t("proxies.col_target")}</strong></DataListCell>,
            <DataListCell key="tls" width={1}><strong>{t("proxies.col_tls")}</strong></DataListCell>,
            <DataListCell key="flags" width={1}><strong>{t("proxies.col_flags")}</strong></DataListCell>,
            <DataListCell key="actions" width={1}><strong>{t("proxies.col_actions")}</strong></DataListCell>,
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
  probeStatuses: Map<string, import("../api/probe").ProbeStatus>;
  servers: ServerDef[];
}) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = buildRouteUrl(proto, proxy.externalPort, proxy);
  const serverName = proxy.namedServerKey
    ? (servers.find(s => s.key === proxy.namedServerKey)?.name ?? proxy.namedServerKey)
    : null;

  return (
    <DataListItem aria-labelledby={`proxy-${proxy.id}`}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="label" width={2}>
              {proxy.label
                ? <strong style={{ fontSize: "1.05em" }}>{proxy.label}</strong>
                : <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>}
            </DataListCell>,
            <DataListCell key="type" width={1}>
              {(() => { const et = entryType(proxy, t); return <Label color={et.color} isCompact>{et.label}</Label>; })()}
            </DataListCell>,
            <DataListCell key="port" width={1}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                id={`proxy-${proxy.id}`}
                style={{ fontFamily: "monospace", fontWeight: "bold" }}
              >
                {proxy.externalHost ? `${proxy.externalHost}:${proxy.externalPort}` : `:${proxy.externalPort}`}
                {proxy.matchers?.path?.[0] ? proxy.matchers.path[0].replace(/\*$/, "…") : ""}
              </a>
              {serverName && (
                <Label
                  isCompact
                  color="green"
                  variant="outline"
                  style={{ marginLeft: "0.35rem", fontSize: "0.75em", verticalAlign: "middle" }}
                >
                  {serverName}
                </Label>
              )}
            </DataListCell>,
            <DataListCell key="target" width={2}>
              {proxy.redirect ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.redirect.to}</code>
              ) : proxy.staticResponse ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.staticResponse.statusCode}{proxy.staticResponse.body ? ` "${proxy.staticResponse.body.slice(0, 30)}${proxy.staticResponse.body.length > 30 ? "…" : ""}"` : ""}</code>
              ) : proxy.fileServer ? (
                <code style={{ fontSize: "0.85em" }}>{proxy.fileServer.root}</code>
              ) : (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
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
            <DataListCell key="tls" width={1}>
              {proxy.redirect ? (
                <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>
              ) : (
                <div style={{ display: "flex", gap: "0.2rem", flexWrap: "wrap" }}>
                  {proxy.tls
                    ? <Label color="blue" isCompact variant="outline">{t("proxies.tls_self_signed")}</Label>
                    : <Label color="grey" isCompact variant="outline">{t("proxies.tls_none")}</Label>}
                  {!proxy.fileServer && proxy.tlsSkipVerify && (
                    <Label color="orange" isCompact variant="outline">{t("proxies.tls_skip_verify")}</Label>
                  )}
                </div>
              )}
            </DataListCell>,
            <DataListCell key="flags" width={1}>
              <FlagChips proxy={proxy} t={t} />
            </DataListCell>,
            <DataListCell key="actions" width={1}>
              <Button variant="plain" size="sm" onClick={() => onEdit(proxy)}>
                {t("common.edit")}
              </Button>
              {" "}
              <Button variant="plain" size="sm" onClick={() => onDuplicate(proxy)}>
                {t("common.duplicate")}
              </Button>
              {" "}
              <Button variant="plain" size="sm" isDanger onClick={() => onDelete(proxy)}>
                {t("common.delete")}
              </Button>
            </DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

interface Props {
  onViewLogs?: (search: string) => void;
  onOpenBackup?: () => void;
}

export function ProxyList({ onViewLogs, onOpenBackup }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    proxies, servers, loading, error, refresh,
    addProxy, editProxy, deleteProxy,
    addServer, editServer, deleteServer,
    needsMigration, migrate,
  } = useProxies();
  const [probeEnabled, setProbeEnabled] = useLocalStorage<boolean>("cockpit-caddy:probe", false, {
    serialize: v => v ? "1" : "0",
    deserialize: r => r === "1",
  });
  const [probeConfirming, setProbeConfirming] = useState(false);
  const { statuses: probeStatuses, refresh: refreshProbe } = useUpstreamProbe(proxies, probeEnabled);

  function handleProbeToggle(_e: unknown, checked: boolean) {
    if (checked) {
      setProbeConfirming(true);
    } else {
      setProbeEnabled(false);
    }
  }

  function confirmProbeEnable() {
    setProbeEnabled(true);
    setProbeConfirming(false);
  }
  const [layout, setLayout] = useLayout<ProxyLayout>("cockpit-caddy:proxy-layout", "list", ["list", "card"]);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useLocalStorage<string>("cockpit-caddy:server-tab", "all");
  const [showAdd, setShowAdd] = useState(false);
  const [showAddRedirect, setShowAddRedirect] = useState(false);
  const [showAddStatic, setShowAddStatic] = useState(false);
  const [showAddRespond, setShowAddRespond] = useState(false);
  const [editing, setEditing] = useState<ProxyEntry | null>(null);
  const [duplicating, setDuplicating] = useState<ProxyEntry | null>(null);

  const [showAddServer, setShowAddServer] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerDef | null>(null);
  const [deletingServer, setDeletingServer] = useState<ServerDef | null>(null);
  const [isDeletingServer, setIsDeletingServer] = useState(false);
  const [deleteServerError, setDeleteServerError] = useState<string | null>(null);

  const [apiError, setApiError] = useState<ApiError | null>(null);

  // Migration gate: the action waiting behind the "Continue anyway" or "Migrate" choice
  const [migrationGate, setMigrationGate] = useState<GateAction | null>(null);

  // Migration confirm modal (also reachable from the banner)
  const [showMigrateConfirm, setShowMigrateConfirm] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  // Standalone delete confirmation
  const [deletingProxy, setDeletingProxy] = useState<ProxyEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const activeServerDef = servers.find(s => s.key === activeTab) ?? null;
  // Pre-select the active server tab in Add dialogs as a convenience
  const initialServerKey = activeServerDef?.key;
  // Only standalone proxy ports count for "port already in use" validation.
  // Named-server routes share the server's listen port — conflicts are caught by addProxy.
  const standaloneExistingPorts = proxies.filter(p => !p.namedServerKey).map(p => p.externalPort);

  // Attempt an action — intercept with gate when migration is needed
  function tryAdd() {
    if (needsMigration) {
      setMigrationGate("add");
    } else {
      setShowAdd(true);
    }
  }

  function tryDuplicate(proxy: ProxyEntry) {
    if (needsMigration) {
      setMigrationGate({ type: "edit", proxy });
    } else {
      setDuplicating(proxy);
    }
  }

  function tryEdit(proxy: ProxyEntry) {
    if (needsMigration) {
      setMigrationGate({ type: "edit", proxy });
    } else {
      setEditing(proxy);
    }
  }

  function tryDelete(proxy: ProxyEntry) {
    if (needsMigration) {
      setMigrationGate({ type: "delete", proxy });
    } else {
      setDeleteError(null);
      setDeletingProxy(proxy);
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingProxy) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteProxy(deletingProxy.id);
      toast.success(t("toast.proxy_deleted", { port: deletingProxy.externalPort }));
      setDeletingProxy(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("proxies.load_failed");
      setDeleteError(msg);
      toast.error(t("proxies.load_failed"), msg);
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleDeleteServerConfirm() {
    if (!deletingServer) return;
    setIsDeletingServer(true);
    setDeleteServerError(null);
    try {
      await deleteServer(deletingServer.key);
      toast.success(t("toast.server_deleted", { name: deletingServer.name }));
      setDeletingServer(null);
      if (activeTab === deletingServer.key) setActiveTab("all");
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("proxies.load_failed");
      setDeleteServerError(msg);
    } finally {
      setIsDeletingServer(false);
    }
  }

  // "Continue anyway" in the gate modal — proceed with the pending action
  function gateForceThrough() {
    const gate = migrationGate;
    setMigrationGate(null);
    if (gate === "add") {
      setShowAdd(true);
    } else if (gate && typeof gate === "object" && gate.type === "edit") {
      setEditing(gate.proxy);
    } else if (gate && typeof gate === "object" && gate.type === "delete") {
      setDeleteError(null);
      setDeletingProxy(gate.proxy);
    }
  }

  // "Migrate first" in the gate modal
  function gateMigrate() {
    setMigrationGate(null);
    setShowMigrateConfirm(true);
  }

  async function handleMigrate() {
    setMigrating(true);
    setMigrateError(null);
    try {
      await migrate();
      setShowMigrateConfirm(false);
    } catch (e) {
      setMigrateError(e instanceof Error ? e.message : t("migration.error"));
    } finally {
      setMigrating(false);
    }
  }

  // Filter proxies based on active tab
  function filterByTab(list: typeof proxies) {
    if (activeTab === "all") return list;
    if (activeTab === "ungrouped") return list.filter(p => !p.namedServerKey);
    // Named server tab: if the server def isn't loaded yet, fall back to showing all
    if (!activeServerDef) return list;
    return list.filter(p => p.namedServerKey === activeTab);
  }

  const filtered = filterByTab(proxies).filter(p => {
    const q = search.toLowerCase();
    return (
      String(p.externalPort).includes(q) ||
      p.targetHost.toLowerCase().includes(q) ||
      String(p.targetPort).includes(q) ||
      (p.label ?? "").toLowerCase().includes(q)
    );
  });

  const ungroupedCount = proxies.filter(p => !p.namedServerKey).length;

  if (loading) {
    return <Spinner />;
  }

  const hasTabs = servers.length > 0;

  return (
    <>
      <Stack hasGutter>
        {needsMigration && (
          <StackItem>
            <Alert
              variant="warning"
              isInline
              title={t("migration.banner_title")}
              actionLinks={
                <>
                  <Button variant="warning" size="sm" onClick={() => setShowMigrateConfirm(true)}>
                    {t("migration.button")}
                  </Button>
                  {onOpenBackup && (
                    <Button variant="link" size="sm" isInline onClick={onOpenBackup}>
                      {t("backup.button")}
                    </Button>
                  )}
                </>
              }
            >
              {t("migration.banner_body")}
            </Alert>
          </StackItem>
        )}

        {apiError && (
          <StackItem>
            <Alert
              variant="warning"
              title={apiError.action === "add" ? t("proxies.api_error_add_title") : t("proxies.api_error_edit_title")}
              actionClose={<AlertActionCloseButton onClose={() => setApiError(null)} />}
              actionLinks={
                <Button
                  variant="link"
                  isInline
                  icon={<ExternalLinkAltIcon />}
                  iconPosition="end"
                  onClick={() => { onViewLogs?.(apiError.search); setApiError(null); }}
                >
                  {t("proxies.view_logs")}
                </Button>
              }
            >
              {apiError.message}
            </Alert>
          </StackItem>
        )}

        {error && (
          <StackItem>
            <Alert
              variant="danger"
              title={t("proxies.load_failed")}
              actionLinks={<Button variant="link" onClick={refresh}>{t("common.retry")}</Button>}
            >
              {error}
            </Alert>
          </StackItem>
        )}

        {probeConfirming && (
          <StackItem>
            <Alert
              variant="info"
              isInline
              title={t("probe.confirm_title")}
              actionClose={<AlertActionCloseButton onClose={() => setProbeConfirming(false)} />}
              style={{ marginBottom: 0 }}
            >
              <p style={{ marginBottom: "0.75rem" }}>{t("probe.confirm_body")}</p>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Button variant="primary" size="sm" onClick={confirmProbeEnable}>{t("probe.confirm_enable")}</Button>
                <Button variant="link" size="sm" onClick={() => setProbeConfirming(false)}>{t("probe.confirm_cancel")}</Button>
              </div>
            </Alert>
          </StackItem>
        )}

        <StackItem>
          <Toolbar>
            <ToolbarContent>
              {/* Route-add buttons — context-aware: when on a server tab they add to that server */}
              <ToolbarItem>
                <Button variant="primary" onClick={tryAdd}>
                  {t("proxies.add_proxy")}
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="secondary" onClick={() => setShowAddRedirect(true)}>
                  {t("proxies.add_redirect")}
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="secondary" onClick={() => setShowAddStatic(true)}>
                  {t("proxies.add_static")}
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="secondary" onClick={() => setShowAddRespond(true)}>
                  {t("proxies.add_respond")}
                </Button>
              </ToolbarItem>
              <ToolbarItem variant="separator" />
              <ToolbarItem>
                <Button variant="tertiary" onClick={() => setShowAddServer(true)}>
                  {t("servers.add_server")}
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <CollapsibleSearch
                  value={search}
                  onChange={setSearch}
                  onClear={() => setSearch("")}
                  placeholder={t("proxies.search_placeholder")}
                  aria-label={t("proxies.search_placeholder")}
                />
              </ToolbarItem>
              <ToolbarItem align={{ default: "alignEnd" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <Switch
                    id="probe-toggle"
                    label={t("probe.toggle_label")}
                    isChecked={probeEnabled || probeConfirming}
                    onChange={handleProbeToggle}
                    aria-label={t("probe.toggle_label")}
                  />
                  <LayoutSelector
                    layout={layout}
                    onLayoutChange={setLayout}
                    layouts={PROXY_LAYOUTS}
                  />
                  <Button
                    variant="plain"
                    onClick={() => { refresh(); refreshProbe(); }}
                    aria-label={t("common.refresh")}
                  >↺</Button>
                </div>
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        </StackItem>

        {hasTabs && (
          <StackItem>
            <Tabs
              activeKey={activeTab}
              onSelect={(_e, key) => setActiveTab(String(key))}
              aria-label="Server tabs"
            >
              <Tab eventKey="all" title={<TabTitleText>{t("servers.tab_all")}</TabTitleText>} />
              {ungroupedCount > 0 || activeTab === "ungrouped" ? (
                <Tab
                  eventKey="ungrouped"
                  title={<TabTitleText>{t("servers.tab_ungrouped")} ({ungroupedCount})</TabTitleText>}
                />
              ) : null}
              {servers.map(def => (
                <Tab
                  key={def.key}
                  eventKey={def.key}
                  title={
                    <TabTitleText>
                      {def.name}
                      <span style={{ marginLeft: "0.4rem", fontSize: "0.8em", color: "var(--pf-t--global--text--color--subtle)", fontFamily: "monospace" }}>
                        {def.listenAddresses[0] ?? ""}
                      </span>
                    </TabTitleText>
                  }
                />
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              )) as any}
            </Tabs>

            </StackItem>
        )}

        <StackItem isFilled>
          {activeServerDef ? (
            <ServerDetailPanel
              server={activeServerDef}
              routes={filtered}
              onEditServer={() => setEditingServer(activeServerDef)}
              onDeleteServer={() => { setDeleteServerError(null); setDeletingServer(activeServerDef); }}
              onEdit={tryEdit}
              onDelete={tryDelete}
              onDuplicate={tryDuplicate}
              onAddProxy={tryAdd}
              probeStatuses={probeStatuses}
            />
          ) : filtered.length === 0 && !error ? (
            <EmptyState>
              <EmptyStateBody>
                {proxies.length === 0 ? t("proxies.empty_body") : t("proxies.empty_title")}
              </EmptyStateBody>
              {proxies.length === 0 && (
                <EmptyStateFooter>
                  <Button variant="primary" onClick={tryAdd}>
                    {t("proxies.add_proxy")}
                  </Button>
                </EmptyStateFooter>
              )}
            </EmptyState>
          ) : layout === "card" ? (
            <Gallery hasGutter minWidths={{ default: "220px" }}>
              {filtered.map(proxy => (
                <ProxyCard
                  key={proxy.id}
                  proxy={proxy}
                  onEdit={tryEdit}
                  onDelete={tryDelete}
                  onDuplicate={tryDuplicate}
                  probeStatuses={probeStatuses}
                />
              ))}
            </Gallery>
          ) : (
            <DataList aria-label={t("proxies.title")} isCompact>
              <HeaderRow />
              {filtered.map(proxy => (
                <ProxyRow
                  key={proxy.id}
                  proxy={proxy}
                  onEdit={tryEdit}
                  onDelete={tryDelete}
                  onDuplicate={tryDuplicate}
                  probeStatuses={probeStatuses}
                  servers={servers}
                />
              ))}
            </DataList>
          )}
        </StackItem>
      </Stack>

      {/* Migration gate modal */}
      <Modal
        isOpen={migrationGate !== null}
        variant="medium"
        onClose={() => setMigrationGate(null)}
        aria-labelledby="migration-gate-title"
      >
        <ModalHeader title={t("migration.gate_title")} labelId="migration-gate-title" />
        <ModalBody>
          <Stack hasGutter>
            <StackItem>
              <Content>{t("migration.gate_body")}</Content>
            </StackItem>
            <StackItem>
              <Alert variant="warning" isInline title={t("migration.gate_continue_warning")} />
            </StackItem>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={gateMigrate}>
            {t("migration.gate_migrate")}
          </Button>
          <Button variant="secondary" onClick={gateForceThrough}>
            {t("migration.gate_continue")}
          </Button>
          <Button variant="link" onClick={() => setMigrationGate(null)}>
            {t("common.cancel")}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Migration confirm modal */}
      <Modal
        isOpen={showMigrateConfirm}
        variant="medium"
        onClose={() => !migrating && setShowMigrateConfirm(false)}
        aria-labelledby="migrate-confirm-title"
      >
        <ModalHeader title={t("migration.confirm_title")} labelId="migrate-confirm-title" />
        <ModalBody>
          <Content>{t("migration.confirm_body")}</Content>
          <Alert
            variant="warning"
            isInline
            title={t("migration.backup_warning_title")}
            style={{ marginTop: "var(--pf-v6-global--spacer--md)" }}
            actionLinks={onOpenBackup && (
              <Button variant="link" isInline onClick={onOpenBackup}>
                {t("backup.button")}
              </Button>
            )}
          >
            {t("migration.backup_warning_body")}
          </Alert>
          {migrateError && (
            <Alert variant="danger" isInline title={t("migration.error")} style={{ marginTop: "var(--pf-v6-global--spacer--md)" }}>
              {migrateError}
            </Alert>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="primary"
            onClick={() => void handleMigrate()}
            isLoading={migrating}
            isDisabled={migrating}
          >
            {t("migration.confirm_action")}
          </Button>
          <Button variant="link" onClick={() => setShowMigrateConfirm(false)} isDisabled={migrating}>
            {t("common.cancel")}
          </Button>
        </ModalFooter>
      </Modal>

      {showAdd && (
        <AddProxyDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setShowAdd(false)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "add" })}
          servers={servers}
          initialServerKey={initialServerKey}
        />
      )}

      {duplicating && (duplicating.redirect ? (
        <AddRedirectDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          servers={servers}
          initialServerKey={duplicating.namedServerKey}
          initialValues={{
            port: duplicating.namedServerKey ? "" : String(duplicating.externalPort),
            to: duplicating.redirect.to,
            code: duplicating.redirect.code,
            label: duplicating.label ? `${duplicating.label} (copy)` : "",
          }}
          initialMatchers={duplicating.matchers}
          initialHandlePath={duplicating.handlePath}
        />
      ) : duplicating.staticResponse ? (
        <AddRespondDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          servers={servers}
          initialServerKey={duplicating.namedServerKey}
          initialValues={{
            port: duplicating.namedServerKey ? "" : String(duplicating.externalPort),
            statusCode: String(duplicating.staticResponse.statusCode),
            body: duplicating.staticResponse.body ?? "",
            close: duplicating.staticResponse.close ?? false,
            label: duplicating.label ? `${duplicating.label} (copy)` : "",
          }}
          initialMatchers={duplicating.matchers}
          initialHandlePath={duplicating.handlePath}
        />
      ) : duplicating.fileServer ? (
        <AddStaticDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          servers={servers}
          initialServerKey={duplicating.namedServerKey}
          initialValues={{
            port: duplicating.namedServerKey ? "" : String(duplicating.externalPort),
            root: duplicating.fileServer.root,
            browse: duplicating.fileServer.browse,
            tls: duplicating.tls,
            compress: duplicating.compress ?? false,
            label: duplicating.label ? `${duplicating.label} (copy)` : "",
          }}
          initialBasicAuth={(duplicating.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash }))}
          initialResponseHeaders={duplicating.responseHeaders}
          initialRequestHeaders={duplicating.requestHeaders}
          initialAccessLog={duplicating.accessLog ? accessLogConfigToValues(duplicating.accessLog) : undefined}
          initialServerTimeouts={{
            readTimeout: duplicating.serverReadTimeout ?? "",
            readHeaderTimeout: duplicating.serverReadHeaderTimeout ?? "",
            writeTimeout: duplicating.serverWriteTimeout ?? "",
            idleTimeout: duplicating.serverIdleTimeout ?? "",
            maxHeaderBytes: duplicating.maxHeaderBytes != null ? String(duplicating.maxHeaderBytes) : "",
          }}
          initialErrorHandlers={duplicating.errorHandlers}
          initialTlsValues={tlsConfigToValues(duplicating.tlsAdvanced, duplicating.mtls)}
          initialMatchers={duplicating.matchers}
          initialHandlePath={duplicating.handlePath}
        />
      ) : (
        <AddProxyDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "add" })}
          servers={servers}
          initialServerKey={duplicating.namedServerKey}
          initialValues={{
            externalScheme: duplicating.namedServerKey ? "" : (duplicating.externalScheme ?? ""),
            externalHost: duplicating.namedServerKey ? "" : (duplicating.externalHost ?? ""),
            externalPort: "",
            targetHost: duplicating.targetHost,
            targetPort: String(duplicating.targetPort),
            targetScheme: duplicating.targetScheme,
            tls: duplicating.tls,
            tlsSkipVerify: duplicating.tlsSkipVerify,
            compress: duplicating.compress ?? false,
            label: duplicating.label ? `${duplicating.label} (copy)` : "",
          }}
          initialRewrite={duplicating.rewrite}
          initialRequestHeaders={duplicating.requestHeaders}
          initialResponseHeaders={duplicating.responseHeaders}
          initialTransport={{
            dialTimeout: duplicating.dialTimeout ?? "",
            responseHeaderTimeout: duplicating.responseHeaderTimeout ?? "",
          }}
          initialBasicAuth={(duplicating.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash }))}
          initialExtraUpstreams={(duplicating.extraUpstreams ?? []).map(u => ({ host: u.host, port: String(u.port) }))}
          initialLbPolicy={duplicating.lbPolicy}
          initialServerTimeouts={{
            readTimeout: duplicating.serverReadTimeout ?? "",
            readHeaderTimeout: duplicating.serverReadHeaderTimeout ?? "",
            writeTimeout: duplicating.serverWriteTimeout ?? "",
            idleTimeout: duplicating.serverIdleTimeout ?? "",
            maxHeaderBytes: duplicating.maxHeaderBytes != null ? String(duplicating.maxHeaderBytes) : "",
          }}
          initialAccessLog={duplicating.accessLog ? accessLogConfigToValues(duplicating.accessLog) : undefined}
          initialErrorHandlers={duplicating.errorHandlers}
          initialForwardAuth={duplicating.forwardAuth}
          initialTlsValues={tlsConfigToValues(duplicating.tlsAdvanced, duplicating.mtls)}
          initialMatchers={duplicating.matchers}
          initialHandlePath={duplicating.handlePath}
          initialIsNamedRoute={duplicating.isNamedRoute}
          initialNamedRouteName={duplicating.namedRouteName}
        />
      ))}

      {showAddRedirect && (
        <AddRedirectDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setShowAddRedirect(false)}
          servers={servers}
          initialServerKey={initialServerKey}
        />
      )}

      {showAddStatic && (
        <AddStaticDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setShowAddStatic(false)}
          servers={servers}
          initialServerKey={initialServerKey}
        />
      )}

      {showAddRespond && (
        <AddRespondDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setShowAddRespond(false)}
          servers={servers}
          initialServerKey={initialServerKey}
        />
      )}

      {editing && (editing.redirect ? (
        <EditRedirectDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id && !p.namedServerKey).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
        />
      ) : editing.staticResponse ? (
        <EditRespondDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id && !p.namedServerKey).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
        />
      ) : editing.fileServer ? (
        <EditStaticDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id && !p.namedServerKey).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
        />
      ) : (
        <EditProxyDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id && !p.namedServerKey).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "edit" })}
        />
      ))}

      {/* Delete confirmation modal */}
      <Modal
        isOpen={deletingProxy !== null}
        variant="small"
        onClose={() => !isDeleting && setDeletingProxy(null)}
        aria-labelledby="delete-proxy-title"
      >
        <ModalHeader
          title={t("proxies.delete_confirm_title", { port: deletingProxy?.externalPort })}
          labelId="delete-proxy-title"
        />
        <ModalBody>
          <Content>
            {t("proxies.delete_confirm_body", {
              port: deletingProxy?.externalPort,
              target: deletingProxy
                ? `${deletingProxy.targetScheme}://${deletingProxy.targetHost}:${deletingProxy.targetPort}`
                : "",
            })}
          </Content>
          {deleteError && (
            <Alert variant="danger" isInline title={deleteError} style={{ marginTop: "var(--pf-v6-global--spacer--md)" }} />
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={() => void handleDeleteConfirm()}
            isLoading={isDeleting}
            isDisabled={isDeleting}
          >
            {t("proxies.delete_confirm_button")}
          </Button>
          <Button variant="link" onClick={() => setDeletingProxy(null)} isDisabled={isDeleting}>
            {t("common.cancel")}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Add Server dialog */}
      {showAddServer && (
        <AddServerDialog
          existingKeys={servers.map(s => s.key)}
          onAdd={async (def) => { await addServer(def); setActiveTab(def.key); }}
          onClose={() => setShowAddServer(false)}
        />
      )}

      {/* Edit Server dialog */}
      {editingServer && (
        <EditServerDialog
          def={editingServer}
          onSave={editServer}
          onClose={() => setEditingServer(null)}
        />
      )}

      {/* Delete Server modal */}
      <Modal
        isOpen={deletingServer !== null}
        variant="small"
        onClose={() => !isDeletingServer && setDeletingServer(null)}
        aria-labelledby="delete-server-title"
      >
        <ModalHeader
          title={t("servers.delete_confirm_title", { name: deletingServer?.name })}
          labelId="delete-server-title"
        />
        <ModalBody>
          <Content>{t("servers.delete_confirm_body")}</Content>
          {deleteServerError && (
            <Alert variant="danger" isInline title={deleteServerError} style={{ marginTop: "var(--pf-v6-global--spacer--md)" }} />
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={() => void handleDeleteServerConfirm()}
            isLoading={isDeletingServer}
            isDisabled={isDeletingServer}
          >
            {t("servers.delete_server")}
          </Button>
          <Button variant="link" onClick={() => setDeletingServer(null)} isDisabled={isDeletingServer}>
            {t("common.cancel")}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
