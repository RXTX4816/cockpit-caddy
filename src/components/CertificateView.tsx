import { useCallback, useState, type ReactNode } from "react";
import { Alert, Button } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { getHost, mkdirp } from "@rxtx4816/cockpit-plugin-base-react/host";

type ShowSaveFilePicker = (opts: object) => Promise<{
  createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }>;
}>;

/**
 * Saves a PEM for the user (shared by the Internal CA and the ACME certificate windows, #282).
 * Uses the browser's save dialog where Cockpit's iframe allows it, otherwise writes the file
 * to ~/Downloads on the server and reports where.
 */
export function useCertDownload() {
  const { t } = useTranslation();
  const [savedPath, setSavedPath] = useState<{ path: string; overwritten: boolean } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = useCallback(async (pem: string, filename: string) => {
    setSavedPath(null);
    setDownloadError(null);

    // Prefer the File System Access API — opens the OS save dialog without any URL
    // navigation, so Cockpit's iframe CSP cannot block it.
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as Window & { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: t("ca.pem_file_type"), accept: { "application/x-pem-file": [".pem"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(pem);
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
      const savePath = `${user.home}/Downloads/${filename}`;
      const host = getHost();
      await mkdirp(host, `${user.home}/Downloads`);
      const existing = await host.readFile(savePath);
      await host.writeFile(savePath, pem);
      setSavedPath({ path: savePath, overwritten: existing !== null });
    } catch (err) {
      setDownloadError((err as { message?: string })?.message ?? String(err));
    }
  }, [t]);

  const result: ReactNode = (
    <>
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
    </>
  );

  return { download, result };
}

interface PemBlockProps {
  pem: string;
  copyLabel: string;
  /** Extra buttons next to Copy, e.g. a download button. */
  actions?: ReactNode;
}

/** A certificate's PEM in a scrollable box, with a Copy button. */
export function PemBlock({ pem, copyLabel, actions }: PemBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(pem).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
      <pre data-testid="cert-pem" style={{
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
      }}>{pem.trim()}</pre>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? t("ca.copied_tip") : copyLabel}
        </Button>
        {actions}
      </div>
    </div>
  );
}
