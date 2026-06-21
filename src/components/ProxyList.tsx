import { useState } from "react";
import {
  Alert,
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
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  SearchInput,
  Spinner,
  Stack,
  StackItem,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { AddProxyDialog } from "./AddProxyDialog";
import { EditProxyDialog } from "./EditProxyDialog";
import { useProxies } from "../hooks/useProxies";
import type { ProxyEntry } from "../api";

// Pending action that the gate modal is guarding
type GateAction = "add" | { type: "edit"; proxy: ProxyEntry };

function HeaderRow() {
  const { t } = useTranslation();
  return (
    <DataListItem aria-labelledby="proxy-list-header" style={{ background: "var(--pf-v6-global--BackgroundColor--200)", color: "var(--pf-v6-global--Color--100)" }}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="port" width={1}><strong>{t("proxies.col_port")}</strong></DataListCell>,
            <DataListCell key="target" width={2}><strong>{t("proxies.col_target")}</strong></DataListCell>,
            <DataListCell key="tls" width={1}><strong>{t("proxies.col_tls")}</strong></DataListCell>,
            <DataListCell key="label" width={2}><strong>{t("proxies.col_label")}</strong></DataListCell>,
            <DataListCell key="actions" width={1}><strong>{t("proxies.col_actions")}</strong></DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

function ProxyRow({ proxy, onEdit }: { proxy: ProxyEntry; onEdit: (p: ProxyEntry) => void }) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = `${proto}://${window.location.hostname}:${proxy.externalPort}`;

  return (
    <DataListItem aria-labelledby={`proxy-${proxy.id}`}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="port" width={1}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                id={`proxy-${proxy.id}`}
                style={{ fontFamily: "monospace", fontWeight: "bold" }}
              >
                :{proxy.externalPort}
              </a>
            </DataListCell>,
            <DataListCell key="target" width={2}>
              <code style={{ fontSize: "0.85em" }}>
                {proxy.targetScheme}://{proxy.targetHost}:{proxy.targetPort}
              </code>
            </DataListCell>,
            <DataListCell key="tls" width={1}>
              {proxy.tls ? (
                <Label color="blue" isCompact>{t("proxies.tls_self_signed")}</Label>
              ) : (
                <Label color="grey" isCompact>{t("proxies.tls_none")}</Label>
              )}
              {proxy.tlsSkipVerify && (
                <>{" "}<Label color="orange" isCompact>{t("proxies.tls_skip_verify")}</Label></>
              )}
            </DataListCell>,
            <DataListCell key="label" width={2}>
              {proxy.label ?? "—"}
            </DataListCell>,
            <DataListCell key="actions" width={1}>
              <Button variant="plain" size="sm" onClick={() => onEdit(proxy)}>
                {t("common.edit")}
              </Button>
            </DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

export function ProxyList() {
  const { t } = useTranslation();
  const { proxies, loading, error, refresh, addProxy, editProxy, deleteProxy, needsMigration, migrate } = useProxies();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ProxyEntry | null>(null);

  // Migration gate: the action waiting behind the "Continue anyway" or "Migrate" choice
  const [migrationGate, setMigrationGate] = useState<GateAction | null>(null);

  // Migration confirm modal (also reachable from the banner)
  const [showMigrateConfirm, setShowMigrateConfirm] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  // Attempt an action — intercept with gate when migration is needed
  function tryAdd() {
    if (needsMigration) {
      setMigrationGate("add");
    } else {
      setShowAdd(true);
    }
  }

  function tryEdit(proxy: ProxyEntry) {
    if (needsMigration) {
      setMigrationGate({ type: "edit", proxy });
    } else {
      setEditing(proxy);
    }
  }

  // "Continue anyway" in the gate modal — proceed with the pending action
  function gateForceThrough() {
    const gate = migrationGate;
    setMigrationGate(null);
    if (gate === "add") {
      setShowAdd(true);
    } else if (gate && typeof gate === "object") {
      setEditing(gate.proxy);
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
                <SearchInput
                  placeholder={t("proxies.search_placeholder")}
                  value={search}
                  onChange={(_e, v) => setSearch(v)}
                  onClear={() => setSearch("")}
                />
              </ToolbarItem>
              <ToolbarItem align={{ default: "alignEnd" }}>
                <Button variant="plain" onClick={refresh} aria-label={t("common.refresh")}>↺</Button>
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
          ) : (
            <DataList aria-label={t("proxies.title")} isCompact>
              <HeaderRow />
              {filtered.map(proxy => (
                <ProxyRow key={proxy.id} proxy={proxy} onEdit={tryEdit} />
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
        />
      )}

      {editing && (
        <EditProxyDialog
          proxy={editing}
          existingPorts={proxies.filter(p => p.id !== editing.id).map(p => p.externalPort)}
          onSave={editProxy}
          onDelete={deleteProxy}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
