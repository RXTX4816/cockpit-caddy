import { useEffect, useState } from "react";
import {
  Alert,
  Button,
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
  ExpandableSection,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { fetchCaddyConfig, classifyAcmeHosts, readGlobalOptions } from "../api";
import type { AcmeHostStatus, GlobalOptions } from "../api";

interface Props {
  onClose: () => void;
}

/**
 * Shows what's actually issuing certificates for each public hostname (#141) — the
 * Settings tab only shows explicit overrides (email, CA, EAB), but Caddy's automatic
 * HTTPS needs none of that: any route with a real public hostname and no explicit
 * opt-out is silently getting a Let's Encrypt cert from Caddy's built-in defaults.
 * This surfaces that per-hostname, instead of leaving it invisible.
 */
export function AcmeStatusModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<AcmeHostStatus[] | null>(null);
  const [globalOptions, setGlobalOptions] = useState<GlobalOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCaddyConfig()
      .then(config => setHosts(classifyAcmeHosts(config)))
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
    readGlobalOptions()
      .then(setGlobalOptions)
      .catch(() => {});
  }, []);

  const acmeHosts = (hosts ?? []).filter(h => h.issuer === "acme");
  const internalHosts = (hosts ?? []).filter(h => h.issuer === "internal");
  const noTlsHosts = (hosts ?? []).filter(h => h.issuer === "none");

  function issuerLabel(status: AcmeHostStatus): string {
    if (status.issuer === "internal") return t("acme.issuer_internal");
    if (status.issuer === "none") return t("acme.issuer_none");
    return t("acme.issuer_acme");
  }

  function sourceBadge(status: AcmeHostStatus) {
    if (status.source === "caddy-default") {
      return <Label isCompact color="orange">{t("acme.source_default")}</Label>;
    }
    if (status.source === "explicit-skip") {
      return <Label isCompact color="grey">{t("acme.source_skip")}</Label>;
    }
    return <Label isCompact color="blue">{t("acme.source_explicit")}</Label>;
  }

  const hasAnyHost = (hosts?.length ?? 0) > 0;

  return (
    <Modal isOpen onClose={onClose} aria-label={t("acme.title")} variant="large">
      <ModalHeader title={t("acme.title")} />
      <ModalBody>
        {error && <Alert variant="danger" isInline title={t("acme.load_error")}>{error}</Alert>}

        {!hosts && !error && (
          <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}>
            <Spinner size="lg" />
          </div>
        )}

        {hosts && !hasAnyHost && (
          <EmptyState>
            <EmptyStateBody>{t("acme.empty_body")}</EmptyStateBody>
          </EmptyState>
        )}

        {hosts && hasAnyHost && (
          <>
            <Alert variant="info" isInline title={t("acme.intro")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
            <DataList aria-label={t("acme.title")} isCompact>
              <DataListItem>
                <DataListItemRow>
                  <DataListItemCells dataListCells={[
                    <DataListCell key="host" width={2}><strong>{t("acme.col_host")}</strong></DataListCell>,
                    <DataListCell key="issuer" width={2}><strong>{t("acme.col_issuer")}</strong></DataListCell>,
                    <DataListCell key="source" width={1}><strong>{t("acme.col_source")}</strong></DataListCell>,
                  ]} />
                </DataListItemRow>
              </DataListItem>
              {[...acmeHosts, ...internalHosts, ...noTlsHosts]
                .sort((a, b) => a.host.localeCompare(b.host))
                .map(status => (
                  <DataListItem key={status.host} aria-labelledby={`acme-host-${status.host}`}>
                    <DataListItemRow>
                      <DataListItemCells dataListCells={[
                        <DataListCell key="host" width={2}>
                          <code id={`acme-host-${status.host}`}>{status.host}</code>
                        </DataListCell>,
                        <DataListCell key="issuer" width={2}>{issuerLabel(status)}</DataListCell>,
                        <DataListCell key="source" width={1}>{sourceBadge(status)}</DataListCell>,
                      ]} />
                    </DataListItemRow>
                  </DataListItem>
                ))}
            </DataList>
          </>
        )}

        {globalOptions && (
          <ExpandableSection
            toggleText={t("acme.account_settings_title")}
            isIndented
            style={{ marginTop: "var(--pf-v6-global--spacer--md)" }}
          >
            <DescriptionList isHorizontal isCompact>
              <DescriptionListGroup>
                <DescriptionListTerm>{t("acme.field_email")}</DescriptionListTerm>
                <DescriptionListDescription>{globalOptions.email || t("acme.value_default")}</DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t("acme.field_ca")}</DescriptionListTerm>
                <DescriptionListDescription>{globalOptions.acmeCA || t("acme.value_default_ca")}</DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t("acme.field_eab")}</DescriptionListTerm>
                <DescriptionListDescription>{globalOptions.acmeEabKeyId || t("acme.value_none")}</DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </ExpandableSection>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="link" onClick={onClose}>{t("common.close")}</Button>
      </ModalFooter>
    </Modal>
  );
}
