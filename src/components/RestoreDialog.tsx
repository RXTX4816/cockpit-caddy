import { useState, useEffect } from "react";
import {
  Alert,
  Button,
  Form,
  FormGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Radio,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@rxtx4816/cockpit-plugin-base-react/components";
import { listTarArchives, extractTarArchive } from "@rxtx4816/cockpit-plugin-base-react/lib/tar";

interface Props {
  onClose: () => void;
}

export function RestoreDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const [scanDir, setScanDir] = useState("/etc/caddy");
  const [scanning, setScanning] = useState(false);
  const [archives, setArchives] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    void scan("/etc/caddy");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scan(dir: string) {
    setScanning(true);
    setScanError(null);
    setArchives([]);
    setSelected(null);
    const found = await listTarArchives(dir, "caddy-config-*.tar.gz", { maxDepth: 2 });
    if (found.length === 0 && dir) {
      setScanError(null);
    }
    setArchives(found);
    if (found.length > 0) setSelected(found[0]);
    setScanning(false);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await cockpit.spawn(["rm", "--", deleteTarget], { superuser: "require", err: "message" });
      setArchives(prev => {
        const next = prev.filter(a => a !== deleteTarget);
        if (selected === deleteTarget) setSelected(next[0] ?? null);
        return next;
      });
      setDeleteTarget(null);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleRestore() {
    if (!selected) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await extractTarArchive(selected, "/etc", { superuser: "require" });
      setSuccess(true);
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
    <Modal isOpen onClose={onClose} variant="medium" aria-label={t("restore.title")}>
      <ModalHeader title={t("restore.title")} />
      <ModalBody>
        {success ? (
          <Alert variant="success" isInline title={t("restore.success_title")}>
            {t("restore.success_body")}
          </Alert>
        ) : (
          <Form isHorizontal>
            <FormGroup label={t("restore.scan_dir_label")} fieldId="rd-scan-dir">
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <TextInput
                  id="rd-scan-dir"
                  value={scanDir}
                  onChange={(_e, v) => setScanDir(v)}
                  isDisabled={scanning || restoring}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void scan(scanDir)}
                  isLoading={scanning}
                  isDisabled={scanning || restoring || !scanDir.trim()}
                >
                  {t("restore.scan_button")}
                </Button>
              </div>
            </FormGroup>

            {scanError && <Alert variant="danger" isInline title={scanError} />}

            {archives.length > 0 && (
              <FormGroup label={t("restore.select_label")} fieldId="rd-select">
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {archives.map(path => (
                    <div key={path} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Radio
                        id={`rd-${path}`}
                        name="rd-archive"
                        label={path.split("/").pop()}
                        description={path}
                        value={path}
                        isChecked={selected === path}
                        onChange={() => setSelected(path)}
                        isDisabled={restoring || deleting}
                        style={{ flex: 1 }}
                      />
                      <Button
                        variant="plain"
                        size="sm"
                        isDanger
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={() => setDeleteTarget(path)}
                        isDisabled={restoring || deleting}
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                </div>
              </FormGroup>
            )}

            {archives.length === 0 && !scanning && !scanError && scanDir && (
              <Alert variant="info" isInline title={t("restore.no_archives")} />
            )}

            {restoreError && <Alert variant="danger" isInline title={restoreError} />}
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        {success ? (
          <Button variant="primary" onClick={onClose}>{t("common.close")}</Button>
        ) : (
          <>
            <Button
              variant="danger"
              onClick={() => void handleRestore()}
              isLoading={restoring}
              isDisabled={restoring || !selected || deleting}
            >
              {t("restore.restore_button")}
            </Button>
            <Button variant="link" onClick={onClose} isDisabled={restoring}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
    <ConfirmDialog
      isOpen={deleteTarget !== null}
      title={t("restore.delete_confirm_title")}
      body={t("restore.delete_confirm_body", { name: deleteTarget?.split("/").pop() })}
      confirmLabel={t("common.delete")}
      variant="danger"
      loading={deleting}
      onConfirm={() => void confirmDelete()}
      onClose={() => setDeleteTarget(null)}
    />
    </>
  );
}
