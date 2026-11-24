import { useEffect, useState, type ReactNode } from "react";
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";
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
  Stack,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import {
  fetchCaddyConfig, classifyAcmeHosts, readGlobalOptions, fetchStorageInfo,
  listStoredCertificates, fetchTlsLogLines, tlsLogEvents, hostCertStatus, readStoredCertificatePem,
} from "../api";
import type { AcmeHostStatus, GlobalOptions, HostCertStatus, StoredCert } from "../api";
import { PemBlock, useCertDownload } from "./CertificateView";

const formatDate = (d: Date) => d.toLocaleDateString(i18n.language, { year: "numeric", month: "short", day: "numeric" });

/** Certificate status of one host (#282): stored certificate, or what the tls log says. */
function CertStatusCell({ status }: { status: HostCertStatus | undefined }) {
  const { t } = useTranslation();
  if (!status) return <Spinner size="sm" aria-label={t("acme.state_loading")} />;
  switch (status.state) {
    case "valid":
      return (
        <Stack>
          <span><Label isCompact color="green">{t("acme.state_valid", { date: formatDate(status.notAfter!) })}</Label></span>
          <small>{t("acme.state_renews", { date: formatDate(status.renewAt!) })}</small>
        </Stack>
      );
    case "renewal-due":
      return <Label isCompact color="orange">{t("acme.state_renewal_due", { date: formatDate(status.notAfter!) })}</Label>;
    case "obtaining":
      return (
        <Stack>
          <span><Label isCompact color="blue">{t("acme.state_obtaining")}</Label></span>
          {status.lastError && <small>{t("acme.last_error", { error: status.lastError })}</small>}
        </Stack>
      );
    case "failed":
      return (
        <Stack>
          <span><Label isCompact color="red">{t("acme.state_failed")}</Label></span>
          <small style={{ wordBreak: "break-word" }} data-testid="cert-error">{status.lastError}</small>
        </Stack>
      );
    default:
      return <Label isCompact color="grey">{t("acme.state_none")}</Label>;
  }
}

/** One stored certificate: names, issuer, validity, fingerprint and the PEM. Never the key. */
function CertificateDetails({ host, cert, storagePath, onBack }: { host: string; cert: StoredCert; storagePath: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [pem, setPem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { download, result } = useCertDownload();

  useEffect(() => {
    readStoredCertificatePem(storagePath, cert.path)
      .then(setPem)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [storagePath, cert.path]);

  const rows: [string, ReactNode][] = [
    [t("acme.cert_subject"), cert.subject],
    [t("acme.cert_sans"), cert.sans.join(", ")],
    [t("acme.cert_issuer"), cert.issuer],
    [t("ca.valid_from"), cert.notBefore.toLocaleString(i18n.language)],
    [t("ca.valid_until"), cert.notAfter.toLocaleString(i18n.language)],
    [t("ca.fingerprint"), <code key="fp" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{cert.fingerprint}</code>],
  ];

  return (
    <div data-testid="acme-cert-view">
      <Button variant="link" isInline onClick={onBack} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
        {t("acme.back")}
      </Button>
      <h3 style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>{t("acme.cert_title", { host })}</h3>
      <DescriptionList isHorizontal isCompact style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
        {rows.map(([term, value]) => (
          <DescriptionListGroup key={term}>
            <DescriptionListTerm>{term}</DescriptionListTerm>
            <DescriptionListDescription>{value}</DescriptionListDescription>
          </DescriptionListGroup>
        ))}
      </DescriptionList>
      {error && <Alert variant="danger" isInline title={t("acme.cert_load_error")}>{error}</Alert>}
      {!pem && !error && <Spinner size="md" />}
      {pem && (
        <PemBlock
          pem={pem}
          copyLabel={t("acme.cert_copy")}
          actions={
            <Button variant="secondary" size="sm" onClick={() => void download(pem, `${host.replace(/^\*\./, "wildcard.")}.pem`)}>
              {t("acme.cert_download")}
            </Button>
          }
        />
      )}
      {result}
    </div>
  );
}

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
  const [certStatus, setCertStatus] = useState<Record<string, HostCertStatus> | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [openHost, setOpenHost] = useState<string | null>(null);

  useEffect(() => {
    const hostsLoaded = fetchCaddyConfig().then(config => {
      const list = classifyAcmeHosts(config);
      setHosts(list);
      return list;
    });
    hostsLoaded.catch(e => setError(e instanceof Error ? e.message : String(e)));
    const optionsLoaded = readGlobalOptions();
    optionsLoaded.then(setGlobalOptions).catch(() => {});

    // #282: certificates from Caddy's storage plus the tls log, per host.
    void (async () => {
      try {
        const [list, opts] = await Promise.all([hostsLoaded, optionsLoaded.catch(() => null)]);
        const storage = await fetchStorageInfo(opts?.storagePath);
        setStoragePath(storage.path);
        const [certs, lines] = await Promise.all([listStoredCertificates(storage.path), fetchTlsLogLines()]);
        const events = tlsLogEvents(lines);
        const now = new Date();
        setCertStatus(Object.fromEntries(
          list.filter(h => h.issuer !== "none").map(h => [h.host, hostCertStatus(h.host, certs, events, now)]),
        ));
      } catch {
        setCertStatus({});
      }
    })();
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

        {openHost && certStatus?.[openHost]?.cert && storagePath && (
          <CertificateDetails
            host={openHost}
            cert={certStatus[openHost].cert!}
            storagePath={storagePath}
            onBack={() => setOpenHost(null)}
          />
        )}

        {hosts && hasAnyHost && !openHost && (
          <>
            <Alert variant="info" isInline title={t("acme.intro")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
            <DataList aria-label={t("acme.title")} isCompact>
              <DataListItem>
                <DataListItemRow>
                  <DataListItemCells dataListCells={[
                    <DataListCell key="host" width={2}><strong>{t("acme.col_host")}</strong></DataListCell>,
                    <DataListCell key="issuer" width={2}><strong>{t("acme.col_issuer")}</strong></DataListCell>,
                    <DataListCell key="source" width={1}><strong>{t("acme.col_source")}</strong></DataListCell>,
                    <DataListCell key="cert" width={2}><strong>{t("acme.col_certificate")}</strong></DataListCell>,
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
                          {certStatus?.[status.host]?.cert ? (
                            <Button variant="link" isInline onClick={() => setOpenHost(status.host)}>
                              <code id={`acme-host-${status.host}`}>{status.host}</code>
                            </Button>
                          ) : (
                            <code id={`acme-host-${status.host}`}>{status.host}</code>
                          )}
                        </DataListCell>,
                        <DataListCell key="issuer" width={2}>{issuerLabel(status)}</DataListCell>,
                        <DataListCell key="source" width={1}>{sourceBadge(status)}</DataListCell>,
                        <DataListCell key="cert" width={2}>
                          {status.issuer === "none" ? "–" : <CertStatusCell status={certStatus ? certStatus[status.host] ?? { host: status.host, state: "none" } : undefined} />}
                        </DataListCell>,
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
