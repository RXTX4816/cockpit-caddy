import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Content,
  Page,
  PageSection,
  Stack,
  StackItem,
  Tab,
  Tabs,
  TabTitleText,
  Title,
} from "@patternfly/react-core";
import { ProxyList } from "./ProxyList";
import { ServiceControl } from "./ServiceControl";
import { useCaddyStatus } from "../hooks/useCaddyStatus";

export function App() {
  const { t } = useTranslation();
  const { status, loading, refresh } = useCaddyStatus();
  const [activeTab, setActiveTab] = useState(0);

  const apiUnreachable = status === "inactive" || status === "failed";

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
            <Tabs
              activeKey={activeTab}
              onSelect={(_e, k) => setActiveTab(Number(k))}
            >
              <Tab eventKey={0} title={<TabTitleText>{t("tabs.proxy_list")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  <ProxyList />
                </PageSection>
              </Tab>
              <Tab eventKey={1} title={<TabTitleText>{t("tabs.caddyfile")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  <Content component="p" style={{ color: "var(--pf-v6-global--Color--200)" }}>
                    {t("caddyfile.title")} — coming soon
                  </Content>
                </PageSection>
              </Tab>
              <Tab eventKey={2} title={<TabTitleText>{t("tabs.logs")}</TabTitleText>}>
                <PageSection hasBodyWrapper={false}>
                  <Content component="p" style={{ color: "var(--pf-v6-global--Color--200)" }}>
                    {t("logs.title")} — coming soon
                  </Content>
                </PageSection>
              </Tab>
            </Tabs>
          </StackItem>
        </Stack>
      </PageSection>
    </Page>
  );
}
