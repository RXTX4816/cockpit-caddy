import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateBody,
  Label,
  PageSection,
  Spinner,
  Stack,
  StackItem,
  Tab,
  Tabs,
  TabTitleText,
  Title,
} from "@patternfly/react-core";
import CogIcon from "@patternfly/react-icons/dist/esm/icons/cog-icon";
import WrenchIcon from "@patternfly/react-icons/dist/esm/icons/wrench-icon";
import { PluginPage, PluginFooter } from "@rxtx4816/cockpit-plugin-base-react/components";
import { useAdminMode, useDialogState } from "@rxtx4816/cockpit-plugin-base-react";
import pkg from "../../package.json";

import { ProxyList } from "./ProxyList";
import { ServiceControl } from "./ServiceControl";
import { CaddyfileEditor } from "./CaddyfileEditor";
import { LogsViewer } from "./LogsViewer";
import { BackupDialog } from "./BackupDialog";
import { RestoreDialog } from "./RestoreDialog";
import { AdminAddressDialog } from "./AdminAddressDialog";
import { InternalCaModal } from "./InternalCaModal";
import { AcmeStatusModal } from "./AcmeStatusModal";
import { ConfigCheckModal } from "./ConfigCheckModal";
import { GlobalOptionsTab } from "./GlobalOptionsTab";
import { useCaddyStatus } from "../hooks/useCaddyStatus";
import { applyStoredAdminAddress } from "../hooks/useAdminAddress";
import { useCaddyVersion } from "../hooks/useCaddyVersion";

function AppInner() {
  const { t } = useTranslation();
  const { status, adminApiOk, loading, refresh } = useCaddyStatus();
  const adminAllowed = useAdminMode();
  const caddyVersion = useCaddyVersion();
  type AppModals = { backup: undefined; restore: undefined; adminAddress: undefined; ca: undefined; acme: undefined; configCheck: undefined };
  const modals = useDialogState<AppModals>(["backup", "restore", "adminAddress", "ca", "acme", "configCheck"]);

  const [activeTab, setActiveTab] = useState(0);
  const [adminBypass, setAdminBypass] = useState(false);
  const [logsSearch, setLogsSearch] = useState("");

  useEffect(() => { applyStoredAdminAddress(); }, []);

  const apiUnreachable = status === "inactive" || status === "failed" ||
    (status === "active" && !adminApiOk);

  const showAdminWarning = adminAllowed === false && !adminBypass;

  return (
    <PluginPage
      fallbackTitle={t("error_boundary.load_error")}
      footer={
        <PluginFooter
          version={pkg.version}
          links={[
            { label: t("footer.help"), href: (pkg.homepage as string) + "/wiki" },
            { label: t("footer.feedback"), href: (pkg.homepage as string) + "/issues/new/choose" },
          ]}
        >
          {caddyVersion && (
            <Label isCompact color="blue">{t("footer.caddy_version", { version: caddyVersion })}</Label>
          )}
        </PluginFooter>
      }
    >
      <Stack hasGutter>
        <StackItem>
          <Stack hasGutter>
            <StackItem>
              <Title headingLevel="h1">{t("app.title")}</Title>
            </StackItem>
            <StackItem>
              <ServiceControl
                status={status}
                loading={loading}
                onRefresh={refresh}
                extraActions={
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <Button variant="secondary" size="sm" icon={<WrenchIcon />} onClick={() => modals.open("configCheck")}>{t("config_check.button")}</Button>
                    <Button variant="secondary" size="sm" onClick={() => modals.open("backup")}>{t("backup.button")}</Button>
                    <Button variant="secondary" size="sm" onClick={() => modals.open("restore")}>{t("restore.button")}</Button>
                    <Button variant="secondary" size="sm" onClick={() => modals.open("ca")}>{t("ca.button")}</Button>
                    <Button variant="secondary" size="sm" onClick={() => modals.open("acme")}>{t("acme.button")}</Button>
                    <Button variant="plain" size="sm" aria-label={t("admin_address.title")} onClick={() => modals.open("adminAddress")}><CogIcon /></Button>
                  </div>
                }
              />
            </StackItem>
          </Stack>
        </StackItem>

        {showAdminWarning && (
          <StackItem>
            <Alert
              variant="warning"
              isInline
              title={t("admin.warning_title")}
              actionLinks={
                <Button variant="link" isInline onClick={() => setAdminBypass(true)}>
                  {t("admin.continue_button")}
                </Button>
              }
            >
              <Content component="p">{t("admin.warning_body")}</Content>
            </Alert>
          </StackItem>
        )}

        {status === "not-installed" && (
          <StackItem>
            <Alert variant="warning" title={t("service.not_installed")}>
              <Content component="p">{t("service.not_installed_body")}</Content>
            </Alert>
          </StackItem>
        )}

        {apiUnreachable && (
          <StackItem>
            <Alert variant="warning" title={t("service.api_unreachable")}>
              <Content component="p">{t("service.api_unreachable_body")}</Content>
            </Alert>
          </StackItem>
        )}

        <StackItem isFilled>
          {loading ? (
            <EmptyState>
              <Spinner size="xl" />
              <EmptyStateBody>{t("app.loading")}</EmptyStateBody>
            </EmptyState>
          ) : (
            <Tabs
              activeKey={activeTab}
              onSelect={(_e, k) => setActiveTab(Number(k))}
            >
              <Tab eventKey={0} title={<TabTitleText>{t("tabs.proxy_list")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  {adminApiOk ? (
                    <ProxyList
                      onViewLogs={(search) => { setLogsSearch(search); setActiveTab(2); }}
                      onOpenBackup={() => modals.open("backup")}
                    />
                  ) : (
                    <EmptyState>
                      <EmptyStateBody>{t("proxies.service_not_running")}</EmptyStateBody>
                    </EmptyState>
                  )}
                </PageSection>
              </Tab>
              <Tab eventKey={1} title={<TabTitleText>{t("tabs.caddyfile")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  <CaddyfileEditor />
                </PageSection>
              </Tab>
              <Tab eventKey={2} title={<TabTitleText>{t("tabs.logs")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  <LogsViewer filterValue={logsSearch} onFilterChange={setLogsSearch} />
                </PageSection>
              </Tab>
              <Tab eventKey={3} title={<TabTitleText>{t("tabs.settings")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  <GlobalOptionsTab />
                </PageSection>
              </Tab>
            </Tabs>
          )}
        </StackItem>
      </Stack>
      {modals.isOpen("backup") && <BackupDialog onClose={() => modals.close("backup")} />}
      {modals.isOpen("restore") && <RestoreDialog onClose={() => modals.close("restore")} />}
      {modals.isOpen("adminAddress") && <AdminAddressDialog onClose={() => modals.close("adminAddress")} />}
      {modals.isOpen("ca") && <InternalCaModal onClose={() => modals.close("ca")} />}
      {modals.isOpen("acme") && <AcmeStatusModal onClose={() => modals.close("acme")} />}
      {modals.isOpen("configCheck") && <ConfigCheckModal onClose={() => modals.close("configCheck")} />}
    </PluginPage>
  );
}

export function App() {
  return <AppInner />;
}
