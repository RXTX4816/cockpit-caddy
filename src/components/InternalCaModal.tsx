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
import { fetchPkiCa, parseCertDetails } from "../api";
import type { PkiCaInfo, CertDetails } from "../api";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "@rxtx4816/cockpit-plugin-base-react/lib/cockpit-fs";

type ShowSaveFilePicker = (opts: object) => Promise<{
  createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }>;
}>;

interface Props {
  onClose: () => void;
}

export function InternalCaModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [ca, setCa] = useState<PkiCaInfo | null>(null);
  const [details, setDetails] = useState<CertDetails | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<{ path: string; overwritten: boolean } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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
  }, []);

  const downloadPem = useCallback(async () => {
    if (!ca) return;
    setSavedPath(null);
    setDownloadError(null);

    // Prefer the File System Access API — opens the OS save dialog without any URL
    // navigation, so Cockpit's iframe CSP cannot block it.
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as Window & { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker({
          suggestedName: "caddy-root-ca.pem",
          types: [{ description: "PEM certificate", accept: { "application/x-pem-file": [".pem"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(ca.rootPem);
        await writable.close();
        return;
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        // SecurityError — showSaveFilePicker is blocked in Cockpit's iframe; fall through.
      }
    }

    // Fallback: Firefox blocks blob:/data: navigation in iframes via frame-src CSP.
    // Write the file to ~/Downloads/ on the server instead.
    try {
      const user = await cockpit.user();
      const savePath = `${user.home}/Downloads/caddy-root-ca.pem`;
      await cockpit.spawn(["mkdir", "-p", "--", `${user.home}/Downloads`], { err: "message" });
      const existing = await fsReadFile(savePath);
      await fsWriteFile(savePath, ca.rootPem);
      setSavedPath({ path: savePath, overwritten: existing !== null });
    } catch (err) {
      setDownloadError((err as { message?: string })?.message ?? String(err));
    }
  }, [ca]);

  function copyPem() {
    if (!ca) return;
    void navigator.clipboard.writeText(ca.rootPem).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Modal isOpen onClose={onClose} aria-label={t("ca.title")} variant="medium">
      <ModalHeader title={t("ca.title")} />
      <ModalBody>
        {error && <Alert variant="danger" isInline title={t("ca.load_error")}>{error}</Alert>}
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

            <div style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
              <pre style={{
                fontFamily: "monospace",
                fontSize: "0.78rem",
                background: "var(--pf-t--global--background--color--secondary--default)",
                padding: "0.75rem",
                borderRadius: "var(--pf-t--global--border--radius--100, 4px)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: "12rem",
                overflowY: "auto",
                margin: 0,
                marginBottom: "0.5rem",
                border: "1px solid var(--pf-t--global--border--color--default)",
              }}>{ca.rootPem.trim()}</pre>
              <Button variant="secondary" size="sm" onClick={copyPem}>
                {copied ? t("ca.copied_tip") : t("ca.copy_tip")}
              </Button>
            </div>

            {savedPath && (
              <Alert
                variant={savedPath.overwritten ? "warning" : "success"}
                isInline
                title={savedPath.overwritten
                  ? t("ca.download_overwritten", { path: savedPath.path })
                  : t("ca.download_saved", { path: savedPath.path })}
                style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}
              />
            )}
            {downloadError && (
              <Alert variant="danger" isInline title={t("ca.download_error")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>{downloadError}</Alert>
            )}

            <ExpandableSection toggleText={t("ca.install_instructions_title")} isIndented>
              <Content>
                <Content component="h4">Linux (system trust store)</Content>
                <ClipboardCopy isReadOnly isCode>
                  {"sudo cp caddy-root-ca.pem /usr/local/share/ca-certificates/caddy-root-ca.crt && sudo update-ca-certificates"}
                </ClipboardCopy>
                <Content component="h4">macOS</Content>
                <ClipboardCopy isReadOnly isCode>
                  {"sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-root-ca.pem"}
                </ClipboardCopy>
                <Content component="h4">Windows (PowerShell, admin)</Content>
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
