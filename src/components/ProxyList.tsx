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
import { useLayout } from "@rxtx4816/cockpit-plugin-base-react";
import { AddProxyDialog } from "./AddProxyDialog";
import { AddRedirectDialog } from "./AddRedirectDialog";
import { AddStaticDialog } from "./AddStaticDialog";
import { EditProxyDialog } from "./EditProxyDialog";
import { EditRedirectDialog } from "./EditRedirectDialog";
import { EditStaticDialog } from "./EditStaticDialog";
import { ProxyCard } from "./ProxyCard";
import { useProxies } from "../hooks/useProxies";
import { useUpstreamStatus } from "../hooks/useUpstreamStatus";
import type { ProxyEntry } from "../api";

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

type EntryTypeColor = "blue" | "purple" | "teal" | "grey" | "green";
interface EntryType { label: string; color: EntryTypeColor; badge?: string }
function entryType(proxy: ProxyEntry, t: (k: string) => string): EntryType {
  if (proxy.redirect) return { label: t("proxies.type_redirect"), color: "purple" };
  if (proxy.fileServer) return { label: t("proxies.type_static"), color: "green", badge: proxy.fileServer.browse ? "browse" : undefined };
  if (proxy.rewrite) return { label: t("proxies.type_proxy"), color: "blue", badge: t(`rewrite.type_${proxy.rewrite.type}`) };
  return { label: t("proxies.type_proxy"), color: "blue" };
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
            <DataListCell key="actions" width={1}><strong>{t("proxies.col_actions")}</strong></DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

function ProxyRow({ proxy, onEdit, onDelete, onDuplicate, upstreamFailing }: {
  proxy: ProxyEntry;
  onEdit: (p: ProxyEntry) => void;
  onDelete: (p: ProxyEntry) => void;
  onDuplicate: (p: ProxyEntry) => void;
  upstreamFailing?: boolean;
}) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = `${proto}://${window.location.hostname}:${proxy.externalPort}`;

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
              {(() => {
                const et = entryType(proxy, t);
                return (
                  <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                    <Label color={et.color} isCompact>{et.label}</Label>
                    {et.badge && <Label color="teal" isCompact>{et.badge}</Label>}
                  </div>
                );
              })()}
            </DataListCell>,
            <DataListCell key="port" width={1}>
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  id={`proxy-${proxy.id}`}
                  style={{ fontFamily: "monospace", fontWeight: "bold" }}
                >
                  :{proxy.externalPort}
                </a>
                {upstreamFailing && (
                  <span
                    title={t("proxies.upstream_failing")}
                    style={{
                      display: "inline-block",
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      backgroundColor: "var(--pf-t--global--color--status--danger--default)",
                      marginLeft: "5px",
                      flexShrink: 0,
                    }}
                  />
                )}
              </span>
            </DataListCell>,
            <DataListCell key="target" width={2}>
              <code style={{ fontSize: "0.85em" }}>
                {proxy.redirect
                  ? proxy.redirect.to
                  : proxy.fileServer
                    ? proxy.fileServer.root
                    : `${proxy.targetScheme}://${proxy.targetHost}:${proxy.targetPort}`}
              </code>
            </DataListCell>,
            <DataListCell key="tls" width={1}>
              {proxy.redirect ? (
                <span style={{ color: "var(--pf-v6-global--Color--200)" }}>—</span>
              ) : proxy.tls ? (
                <Label color="blue" isCompact>{t("proxies.tls_self_signed")}</Label>
              ) : (
                <Label color="grey" isCompact>{t("proxies.tls_none")}</Label>
              )}
              {!proxy.redirect && !proxy.fileServer && proxy.tlsSkipVerify && (
                <>{" "}<Label color="orange" isCompact>{t("proxies.tls_skip_verify")}</Label></>
              )}
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
}

export function ProxyList({ onViewLogs }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const { proxies, loading, error, refresh, addProxy, editProxy, deleteProxy, needsMigration, migrate } = useProxies();
  const failingUpstreams = useUpstreamStatus();
  const [layout, setLayout] = useLayout<ProxyLayout>("cockpit-caddy:proxy-layout", "list", ["list", "card"]);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showAddRedirect, setShowAddRedirect] = useState(false);
  const [showAddStatic, setShowAddStatic] = useState(false);
  const [editing, setEditing] = useState<ProxyEntry | null>(null);
  const [duplicating, setDuplicating] = useState<ProxyEntry | null>(null);

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
      await deleteProxy(deletingProxy.serverKey);
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

  const filtered = proxies.filter(p => {
    const q = search.toLowerCase();
    return (
      String(p.externalPort).includes(q) ||
      p.targetHost.toLowerCase().includes(q) ||
      String(p.targetPort).includes(q) ||
      (p.label ?? "").toLowerCase().includes(q)
    );
  });

  if (loading) {
    return <Spinner />;
  }

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
                <Button variant="warning" size="sm" onClick={() => setShowMigrateConfirm(true)}>
                  {t("migration.button")}
                </Button>
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

        <StackItem>
          <Toolbar>
            <ToolbarContent>
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
                <CollapsibleSearch
                  value={search}
                  onChange={setSearch}
                  onClear={() => setSearch("")}
                  placeholder={t("proxies.search_placeholder")}
                  aria-label={t("proxies.search_placeholder")}
                />
              </ToolbarItem>
              <ToolbarItem align={{ default: "alignEnd" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <LayoutSelector
                    layout={layout}
                    onLayoutChange={setLayout}
                    layouts={PROXY_LAYOUTS}
                  />
                  <Button variant="plain" onClick={refresh} aria-label={t("common.refresh")}>↺</Button>
                </div>
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        </StackItem>

        <StackItem isFilled>
          {filtered.length === 0 && !error ? (
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
                  upstreamFailing={failingUpstreams.has(`${proxy.targetHost}:${proxy.targetPort}`)}
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
                  upstreamFailing={failingUpstreams.has(`${proxy.targetHost}:${proxy.targetPort}`)}
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
          existingPorts={proxies.map(p => p.externalPort)}
          onAdd={addProxy}
          onClose={() => setShowAdd(false)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "add" })}
        />
      )}

      {duplicating && (duplicating.redirect ? (
        <AddRedirectDialog
          existingPorts={proxies.map(p => p.externalPort)}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          initialValues={{
            port: "",
            to: duplicating.redirect.to,
            code: duplicating.redirect.code,
            label: duplicating.label ? `${duplicating.label} (copy)` : "",
          }}
        />
      ) : duplicating.fileServer ? (
        <AddStaticDialog
          existingPorts={proxies.map(p => p.externalPort)}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          initialValues={{
            port: "",
            root: duplicating.fileServer.root,
            browse: duplicating.fileServer.browse,
            tls: duplicating.tls,
            label: duplicating.label ? `${duplicating.label} (copy)` : "",
          }}
        />
      ) : (
        <AddProxyDialog
          existingPorts={proxies.map(p => p.externalPort)}
          onAdd={addProxy}
          onClose={() => setDuplicating(null)}
          onApiError={msg => setApiError({ message: msg, search: extractLogsSearch(msg), action: "add" })}
          initialValues={{
            externalScheme: duplicating.externalScheme ?? "",
            externalHost: duplicating.externalHost ?? "",
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
        />
      ))}

      {showAddRedirect && (
        <AddRedirectDialog
          existingPorts={proxies.map(p => p.externalPort)}
          onAdd={addProxy}
          onClose={() => setShowAddRedirect(false)}
        />
      )}

      {showAddStatic && (
        <AddStaticDialog
          existingPorts={proxies.map(p => p.externalPort)}
          onAdd={addProxy}
          onClose={() => setShowAddStatic(false)}
        />
      )}

      {editing && (editing.redirect ? (
        <EditRedirectDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
        />
      ) : editing.fileServer ? (
        <EditStaticDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id).map(p => p.externalPort)}
          onSave={editProxy}
          onClose={() => setEditing(null)}
        />
      ) : (
        <EditProxyDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id).map(p => p.externalPort)}
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
    </>
  );
}
