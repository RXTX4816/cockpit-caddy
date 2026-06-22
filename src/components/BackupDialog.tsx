import { useState } from "react";
import {
  Alert,
  Button,
  Form,
  FormGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { formatArchiveTimestamp } from "@rxtx4816/cockpit-plugin-base-react/lib/timestamp";
import { createTarArchive } from "@rxtx4816/cockpit-plugin-base-react/lib/tar";

interface Props {
  onClose: () => void;
}

export function BackupDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const [destDir, setDestDir] = useState("/etc/caddy");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const filename = `caddy-config-${formatArchiveTimestamp(new Date())}.tar.gz`;
  const destPath = `${destDir.replace(/\/$/, "")}/${filename}`;

  async function handleCreate() {
    setRunning(true);
    setError(null);
    setWarning(null);
    try {
      await cockpit.spawn(["mkdir", "-p", "--", destDir.replace(/\/$/, "")], { superuser: "require", err: "message" });
      const { warning: warn } = await createTarArchive(destPath, "/etc", "caddy", {
        exclude: ["*.tar.gz"],
        superuser: "require",
      });
      setSavedPath(destPath);
      if (warn) setWarning(warn);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} variant="small" aria-label={t("backup.title")}>
      <ModalHeader title={t("backup.title")} />
      <ModalBody>
        {savedPath ? (
          <>
            <Alert variant="success" isInline title={t("backup.success_title")}>
              {t("backup.success_body", { path: savedPath })}
            </Alert>
            {warning && (
              <Alert variant="warning" isInline title={t("backup.warning_partial")} style={{ marginTop: "0.5rem" }}>
                {warning}
              </Alert>
            )}
          </>
        ) : (
          <Form isHorizontal>
            <FormGroup label={t("backup.dest_dir_label")} fieldId="bd-dest-dir">
              <TextInput
                id="bd-dest-dir"
                value={destDir}
                onChange={(_e, v) => setDestDir(v)}
                isDisabled={running}
              />
            </FormGroup>
            <FormGroup label={t("backup.archive_preview_label")} fieldId="bd-preview">
              <TextInput id="bd-preview" value={destPath} isDisabled readOnly />
            </FormGroup>
            {error && <Alert variant="danger" isInline title={error} />}
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        {savedPath ? (
          <Button variant="primary" onClick={onClose}>{t("common.close")}</Button>
        ) : (
          <>
            <Button variant="primary" onClick={() => void handleCreate()} isLoading={running} isDisabled={running || !destDir.trim()}>
              {t("backup.create_button")}
            </Button>
            <Button variant="link" onClick={onClose} isDisabled={running}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
