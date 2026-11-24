import { useState, useEffect, useCallback } from "react";
import {
  Alert,
  Button,
  ClipboardCopy,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { fetchPkiCa, parseCertDetails, fetchCaddyConfig } from "../api";
import type { PkiCaInfo, CertDetails } from "../api";
import { PemBlock, useCertDownload } from "./CertificateView";

interface Props {
  onClose: () => void;
}

export function InternalCaModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [ca, setCa] = useState<PkiCaInfo | null>(null);
  const [details, setDetails] = useState<CertDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usesInternalCa, setUsesInternalCa] = useState(true);

  useEffect(() => {
    fetchPkiCa()
      .then(async info => {
        setCa(info);
        try {
          setDetails(await parseCertDetails(info.rootPem));
        } catch {
          // cert details are non-essential; silently skip if openssl unavailable
        }
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));

    // The internal CA is only used as the leaf-cert issuer when at least one
    // proxy has "Self-signed" TLS enabled (mergeProxy sets this app-wide policy).
    // Otherwise public sites get their certs from Let's Encrypt/ACME instead,
    // so this modal's cert doesn't correspond to what visitors actually see.
    fetchCaddyConfig()
      .then(config => {
        const inUse = (config.apps?.tls?.automation?.policies ?? [])
          .some(p => (p.issuers ?? []).some(i => i.module === "internal"));
        setUsesInternalCa(inUse);
      })
      .catch(() => {});
  }, []);

  const { download: downloadCert, result: downloadResult } = useCertDownload();

  const downloadPem = useCallback(() => downloadCert(ca?.rootPem ?? "", "caddy-root-ca.pem"), [ca, downloadCert]);
  const downloadIntermediatePem = useCallback(
    () => downloadCert(ca?.intermediatePem ?? "", "caddy-intermediate-ca.pem"),
    [ca, downloadCert],
  );

  return (
    <Modal isOpen onClose={onClose} aria-label={t("ca.title")} variant="medium">
      <ModalHeader title={t("ca.title")} />
      <ModalBody>
        {error && <Alert variant="danger" isInline title={t("ca.load_error")}>{error}</Alert>}
        {ca && !usesInternalCa && (
          <Alert
            variant="warning"
            isInline
            title={t("ca.not_in_use_title")}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          >
            {t("ca.not_in_use_body")}
          </Alert>
        )}
        {!ca && !error && (
          <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}>
            <Spinner size="lg" />
          </div>
        )}
        {ca && (
          <>
            <DescriptionList isHorizontal isCompact style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
              <DescriptionListGroup>
                <DescriptionListTerm>{t("ca.root_cn")}</DescriptionListTerm>
                <DescriptionListDescription>{ca.rootCommonName}</DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t("ca.intermediate_cn")}</DescriptionListTerm>
                <DescriptionListDescription>{ca.intermediateCommonName}</DescriptionListDescription>
              </DescriptionListGroup>
              {details && (
                <>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t("ca.valid_from")}</DescriptionListTerm>
                    <DescriptionListDescription>{details.notBefore}</DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t("ca.valid_until")}</DescriptionListTerm>
                    <DescriptionListDescription>{details.notAfter}</DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t("ca.fingerprint")}</DescriptionListTerm>
                    <DescriptionListDescription>
                      <code style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{details.fingerprint}</code>
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                </>
              )}
            </DescriptionList>

            <PemBlock pem={ca.rootPem} copyLabel={t("ca.copy_tip")} />

            <ExpandableSection toggleText={t("ca.intermediate_cn")} isIndented style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
              <PemBlock
                pem={ca.intermediatePem}
                copyLabel={t("ca.copy_intermediate_tip")}
                actions={
                  <Button variant="secondary" size="sm" onClick={() => void downloadIntermediatePem()}>
                    {t("ca.download_intermediate_button")}
                  </Button>
                }
              />
            </ExpandableSection>

            {downloadResult}

            <ExpandableSection toggleText={t("ca.install_instructions_title")} isIndented>
              <Content>
                <Content component="h4">{t("ca.install_linux")}</Content>
                <ClipboardCopy isReadOnly isCode>
                  {"sudo cp caddy-root-ca.pem /usr/local/share/ca-certificates/caddy-root-ca.crt && sudo update-ca-certificates"}
                </ClipboardCopy>
                <Content component="h4">macOS</Content>
                <ClipboardCopy isReadOnly isCode>
                  {"sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-root-ca.pem"}
                </ClipboardCopy>
                <Content component="h4">{t("ca.install_windows")}</Content>
                <ClipboardCopy isReadOnly isCode>
                  {"Import-Certificate -FilePath caddy-root-ca.pem -CertStoreLocation Cert:\\LocalMachine\\Root"}
                </ClipboardCopy>
                <Content component="h4">Firefox</Content>
                <Content component="p">{t("ca.firefox_instructions")}</Content>
              </Content>
            </ExpandableSection>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {ca && (
          <Button variant="primary" onClick={() => void downloadPem()}>
            {t("ca.download_button")}
          </Button>
        )}
        <Button variant="link" onClick={onClose}>{t("common.close")}</Button>
      </ModalFooter>
    </Modal>
  );
}
