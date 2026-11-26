import { useState } from "react";
import {
  AlertActionCloseButton,
  Button,
  Content,
  Divider,
  Dropdown,
  DropdownItem,
  DropdownList,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  Gallery,
  MenuToggle,
  MenuToggleAction,
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
  Tooltip,
  ExpandableSection,
} from "@patternfly/react-core";
import { ExternalLinkAltIcon, ListAltIcon, SyncAltIcon, ThIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";
import {
  useToast,
  CollapsibleSearch,
  LayoutSelector,
  type LayoutOption,
} from "@rxtx4816/cockpit-plugin-base-react/components";
import { useLayout, useLocalStorage } from "@rxtx4816/cockpit-plugin-base-react";
import { tlsModeOf } from "./TlsModeField";
import { AddProxyDialog } from "./AddProxyDialog";
import { AddRedirectDialog } from "./AddRedirectDialog";
import { AddStaticDialog } from "./AddStaticDialog";
import { AddRespondDialog } from "./AddRespondDialog";
import { AddPhpFastcgiDialog } from "./AddPhpFastcgiDialog";
import { EditProxyDialog } from "./EditProxyDialog";
import { EditRedirectDialog } from "./EditRedirectDialog";
import { EditStaticDialog } from "./EditStaticDialog";
import { EditRespondDialog } from "./EditRespondDialog";
import { EditPhpFastcgiDialog } from "./EditPhpFastcgiDialog";
import { envRecordToEntries } from "./PhpFastcgiEnvSection";
import { AddServerDialog } from "./AddServerDialog";
import { EditServerDialog } from "./EditServerDialog";
import { ServerDetailPanel } from "./ServerDetailPanel";
import { ProxyCard } from "./ProxyCard";
import { ProxyRows } from "./ProxyRows";
import { useIsNarrow } from "./useIsNarrow";
import { useProxies } from "../hooks/useProxies";
import { SnippetsContext } from "./SnippetImportsField";
import { useUpstreamProbe } from "../hooks/useUpstreamProbe";
import type { ProxyEntry, ServerDef } from "../api";
import { proxyTabStateFromEntry } from "./proxyTabState";
import { Notice } from "./Notice";

type ProxyLayout = "list" | "card";
/** `label` holds the i18n key; it's translated where the selector is rendered. */
const PROXY_LAYOUTS: LayoutOption<ProxyLayout>[] = [
  { key: "list", icon: <ListAltIcon />, label: "proxies.layout_list" },
  { key: "card", icon: <ThIcon />,      label: "proxies.layout_cards" },
];

interface ApiError { message: string; search: string; action: "add" | "edit" }

function extractLogsSearch(message: string): string {
  const code = message.match(/\b(?:HTTP|status|code)[/ :]+([45]\d{2})\b/i)?.[1];
  return code ? `"status_code":${code}` : message.substring(0, 60);
}

// Pending action that the gate modal is guarding
type GateAction = "add" | { type: "edit"; proxy: ProxyEntry } | { type: "delete"; proxy: ProxyEntry };

interface Props {
  onViewLogs?: (search: string) => void;
  onOpenBackup?: () => void;
}

export function ProxyList({ onViewLogs, onOpenBackup }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    proxies, servers, loading, error, refresh,
    addProxy, editProxy, saveSiteText, deleteProxy,
    addServer, editServer, deleteServer,
    needsMigration, migrate, snippets,
  } = useProxies();
  const [probeEnabled, setProbeEnabled] = useLocalStorage<boolean>("cockpit-caddy:probe", false, {
    serialize: v => v ? "1" : "0",
    deserialize: r => r === "1",
  });
  const [probeConfirming, setProbeConfirming] = useState(false);
  const { statuses: probeStatuses, refresh: refreshProbe } = useUpstreamProbe(proxies, probeEnabled);
  const narrow = useIsNarrow();

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
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [showAddRedirect, setShowAddRedirect] = useState(false);
  const [showAddStatic, setShowAddStatic] = useState(false);
  const [showAddRespond, setShowAddRespond] = useState(false);
  const [showAddPhp, setShowAddPhp] = useState(false);
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
  const standaloneProxies = proxies.filter(p => !p.namedServerKey);
  const standaloneExistingPorts = standaloneProxies.map(p => p.externalPort);

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
    <SnippetsContext.Provider value={snippets}>
      <Stack hasGutter>
        {needsMigration && (
          <StackItem>
            <Notice
              variant="warning"
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
              <Content component="p">{t("migration.banner_body")}</Content>
              <ExpandableSection toggleText={t("migration.banner_details_toggle")} data-testid="migration-details">
                <Content component="p">{t("migration.banner_details")}</Content>
              </ExpandableSection>
            </Notice>
          </StackItem>
        )}

        {apiError && (
          <StackItem>
            <Notice isInline={false}
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
            </Notice>
          </StackItem>
        )}

        {error && (
          <StackItem>
            <Notice isInline={false}
              variant="danger"
              title={t("proxies.load_failed")}
              actionLinks={<Button variant="link" onClick={refresh}>{t("common.retry")}</Button>}
            >
              {error}
            </Notice>
          </StackItem>
        )}

        {probeConfirming && (
          <StackItem>
            <Notice
              variant="info"
              title={t("probe.confirm_title")}
              actionClose={<AlertActionCloseButton onClose={() => setProbeConfirming(false)} />}
            >
              <p style={{ marginBottom: "0.75rem" }}>{t("probe.confirm_body")}</p>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Button variant="primary" size="sm" onClick={confirmProbeEnable}>{t("probe.confirm_enable")}</Button>
                <Button variant="link" size="sm" onClick={() => setProbeConfirming(false)}>{t("probe.confirm_cancel")}</Button>
              </div>
            </Notice>
          </StackItem>
        )}

        <StackItem>
          <Toolbar>
            <ToolbarContent>
              {/* Add menu (#259) — context-aware: on a server tab it adds to that server */}
              <ToolbarItem>
                <Dropdown
                  isOpen={addMenuOpen}
                  onOpenChange={setAddMenuOpen}
                  onSelect={() => setAddMenuOpen(false)}
                  toggle={ref => (
                    <MenuToggle
                      ref={ref}
                      variant="primary"
                      isExpanded={addMenuOpen}
                      onClick={() => setAddMenuOpen(o => !o)}
                      aria-label={t("proxies.add_menu")}
                      splitButtonItems={[
                        <MenuToggleAction key="add-proxy" onClick={tryAdd}>{t("proxies.add_proxy")}</MenuToggleAction>,
                      ]}
                    />
                  )}
                >
                  <DropdownList>
                    <DropdownItem onClick={tryAdd}>{t("proxies.menu_proxy")}</DropdownItem>
                    <DropdownItem onClick={() => setShowAddRedirect(true)}>{t("proxies.menu_redirect")}</DropdownItem>
                    <DropdownItem onClick={() => setShowAddStatic(true)}>{t("proxies.menu_static")}</DropdownItem>
                    <DropdownItem onClick={() => setShowAddRespond(true)}>{t("proxies.menu_respond")}</DropdownItem>
                    {!initialServerKey && (
                      <DropdownItem onClick={() => setShowAddPhp(true)}>{t("proxies.menu_php")}</DropdownItem>
                    )}
                    {/* At phone width (#258) Add server joins this menu instead of its own button. */}
                    {narrow && <Divider component="li" />}
                    {narrow && <DropdownItem onClick={() => setShowAddServer(true)}>{t("servers.add_server")}</DropdownItem>}
                  </DropdownList>
                </Dropdown>
              </ToolbarItem>
              {!narrow && (
                <ToolbarItem>
                  <Button variant="secondary" onClick={() => setShowAddServer(true)}>
                    {t("servers.add_server")}
                  </Button>
                </ToolbarItem>
              )}
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
                    layouts={PROXY_LAYOUTS.map(l => ({ ...l, label: t(l.label) }))}
                  />
                  <Tooltip content={t("common.refresh")}>
                    <Button
                      variant="plain"
                      onClick={() => { refresh(); refreshProbe(); }}
                      aria-label={t("common.refresh")}
                      icon={<SyncAltIcon />}
                    />
                  </Tooltip>
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
              aria-label={t("servers.tabs_aria")}
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
            <ProxyRows
              proxies={filtered}
              compact={narrow}
              onEdit={tryEdit}
              onDelete={tryDelete}
              onDuplicate={tryDuplicate}
              probeStatuses={probeStatuses}
              servers={servers}
            />
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
              <Notice variant="warning" title={t("migration.gate_continue_title")}>{t("migration.gate_continue_warning")}</Notice>
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
          <Notice
            variant="warning"
            title={t("migration.backup_warning_title")}
            actionLinks={onOpenBackup && (
              <Button variant="link" isInline onClick={onOpenBackup}>
                {t("backup.button")}
              </Button>
            )}
          >
            {t("migration.backup_warning_body")}
          </Notice>
          {migrateError && (
            <Notice variant="danger" title={t("migration.error")}>
              {migrateError}
            </Notice>
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
          existingRoutes={standaloneProxies}
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
            code: duplicating.redirect.html ? "html" : duplicating.redirect.code,
            label: duplicating.label ? t("proxies.copy_label", { label: duplicating.label }) : "",
          }}
          initialTabState={proxyTabStateFromEntry(duplicating)}
          initialImports={duplicating.imports}
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
            label: duplicating.label ? t("proxies.copy_label", { label: duplicating.label }) : "",
          }}
          initialTabState={proxyTabStateFromEntry(duplicating)}
          initialImports={duplicating.imports}
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
            fileServer: duplicating.fileServer,
            tls: duplicating.tls,
            compress: duplicating.compress ?? false,
            label: duplicating.label ? t("proxies.copy_label", { label: duplicating.label }) : "",
          }}
          initialTabState={proxyTabStateFromEntry(duplicating)}
          initialImports={duplicating.imports}
        />
      ) : duplicating.phpFastcgi ? (
        <AddPhpFastcgiDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          initialValues={{
            port: String(duplicating.externalPort),
            upstream: duplicating.phpFastcgi.upstream,
            root: duplicating.phpFastcgi.root,
            index: duplicating.phpFastcgi.index ?? "",
            splitPath: duplicating.phpFastcgi.splitPath?.join(" ") ?? "",
            tryFiles: duplicating.phpFastcgi.tryFiles ?? "",
            phpOptions: duplicating.phpFastcgi,
            tls: duplicating.tls,
            compress: duplicating.compress ?? false,
            label: duplicating.label ? t("proxies.copy_label", { label: duplicating.label }) : "",
          }}
          initialEnv={envRecordToEntries(duplicating.phpFastcgi.env)}
          initialTabState={proxyTabStateFromEntry(duplicating)}
          initialImports={duplicating.imports}
        />
      ) : (
        <AddProxyDialog
          existingRoutes={standaloneProxies}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "add" })}
          servers={servers}
          initialTlsMode={tlsModeOf(duplicating)}
          initialTlsOnDemand={duplicating.tlsOnDemand}
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
            label: duplicating.label ? t("proxies.copy_label", { label: duplicating.label }) : "",
          }}
          initialTabState={proxyTabStateFromEntry(duplicating)}
          initialImports={duplicating.imports}
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

      {showAddPhp && (
        <AddPhpFastcgiDialog
          existingPorts={standaloneExistingPorts}
          onAdd={addProxy}
          onClose={() => setShowAddPhp(false)}
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
      ) : editing.phpFastcgi ? (
        <EditPhpFastcgiDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id && !p.namedServerKey).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
        />
      ) : (
        <EditProxyDialog
          proxy={editing}
          existingRoutes={proxies.filter(p => p.id !== editing.id && !p.namedServerKey)}
          onSave={editProxy}
          onSaveSiteText={(text, expected) => saveSiteText(editing, text, expected)}
          onClose={() => setEditing(null)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "edit" })}
          servers={servers}
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
            <Notice variant="danger" title={deleteError} />
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
            <Notice variant="danger" title={deleteServerError} />
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
    </SnippetsContext.Provider>
  );
}
