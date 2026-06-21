import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateBody,
  Page,
  PageSection,
  Spinner,
  Stack,
  StackItem,
  Tab,
  Tabs,
  TabTitleText,
  Title,
} from "@patternfly/react-core";
import { ErrorBoundary, ToastProvider } from "@rxtx4816/cockpit-plugin-base-react/components";

import { ProxyList } from "./ProxyList";
import { ServiceControl } from "./ServiceControl";
import { CaddyfileEditor } from "./CaddyfileEditor";
import { LogsViewer } from "./LogsViewer";
import { useCaddyStatus } from "../hooks/useCaddyStatus";
import { useAdminMode } from "../hooks/useAdminMode";

function AppInner() {
  const { t } = useTranslation();
  const { status, adminApiOk, loading, refresh } = useCaddyStatus();
  const adminAllowed = useAdminMode();
  const [activeTab, setActiveTab] = useState(0);
  const [adminBypass, setAdminBypass] = useState(false);

  const apiUnreachable = status === "inactive" || status === "failed" ||
    (status === "active" && !adminApiOk);

  const showAdminWarning = adminAllowed === false && !adminBypass;

  return (
    <Page className="pf-m-no-sidebar">
      <PageSection hasBodyWrapper={false} isFilled>
        <Stack hasGutter>
          <StackItem>
            <Stack hasGutter>
              <StackItem>
                <Title headingLevel="h1">{t("app.title")}</Title>
              </StackItem>
              <StackItem>
                <ServiceControl status={status} loading={loading} onRefresh={refresh} />
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
                      <ProxyList />
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
                    <LogsViewer />
                  </PageSection>
                </Tab>
              </Tabs>
            )}
          </StackItem>
        </Stack>
      </PageSection>
    </Page>
  );
}

export function App() {
  return (
    <ErrorBoundary fallbackTitle="Error loading Caddy plugin">
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </ErrorBoundary>
  );
}
