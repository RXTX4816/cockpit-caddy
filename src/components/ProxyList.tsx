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

function HeaderRow() {
  const { t } = useTranslation();
  return (
    <DataListItem aria-labelledby="proxy-list-header" style={{ background: "var(--pf-v6-global--BackgroundColor--200, #f5f5f5)" }}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="port" width={1}><strong>{t("proxies.col_port")}</strong></DataListCell>,
            <DataListCell key="target" width={2}><strong>{t("proxies.col_target")}</strong></DataListCell>,
            <DataListCell key="tls" width={1}><strong>{t("proxies.col_tls")}</strong></DataListCell>,
            <DataListCell key="label" width={2}><strong>{t("proxies.col_label")}</strong></DataListCell>,
            <DataListCell key="actions" width={2}><strong>{t("proxies.col_actions")}</strong></DataListCell>,
          ]}
        />
      </DataListItemRow>
    </DataListItem>
  );
}

function ProxyRow({ proxy, onEdit }: { proxy: ProxyEntry; onEdit: (p: ProxyEntry) => void }) {
  const { t } = useTranslation();

  function copyUrl() {
    const proto = proxy.tls ? "https" : "http";
    void navigator.clipboard.writeText(`${proto}://${window.location.hostname}:${proxy.externalPort}`);
  }

  return (
    <DataListItem aria-labelledby={`proxy-${proxy.id}`}>
      <DataListItemRow>
        <DataListItemCells
          dataListCells={[
            <DataListCell key="port" width={1}>
              <Content component="small" id={`proxy-${proxy.id}`}>
                <strong>:{proxy.externalPort}</strong>
              </Content>
            </DataListCell>,
            <DataListCell key="target" width={2}>
              {proxy.targetHost}:{proxy.targetPort}
            </DataListCell>,
            <DataListCell key="tls" width={1}>
              {proxy.tls ? (
                <Label color="blue" isCompact>{t("proxies.tls_self_signed")}</Label>
              ) : (
                <Label color="grey" isCompact>{t("proxies.tls_none")}</Label>
              )}
            </DataListCell>,
            <DataListCell key="label" width={2}>
              {proxy.label ?? "—"}
            </DataListCell>,
            <DataListCell key="actions" width={2}>
              <Button variant="plain" size="sm" onClick={copyUrl}>
                {t("proxies.copy_url")}
              </Button>
              {" "}
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
  const { proxies, loading, error, refresh, addProxy, editProxy, deleteProxy } = useProxies();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ProxyEntry | null>(null);

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
    <Stack hasGutter>
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
              <Button variant="primary" onClick={() => setShowAdd(true)}>
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
                <Button variant="primary" onClick={() => setShowAdd(true)}>
                  {t("proxies.add_proxy")}
                </Button>
              </EmptyStateFooter>
            )}
          </EmptyState>
        ) : (
          <DataList aria-label={t("proxies.title")} isCompact>
            <HeaderRow />
            {filtered.map(proxy => (
              <ProxyRow key={proxy.id} proxy={proxy} onEdit={setEditing} />
            ))}
          </DataList>
        )}
      </StackItem>

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
          onSave={editProxy}
          onDelete={deleteProxy}
          onClose={() => setEditing(null)}
        />
      )}
    </Stack>
  );
}
