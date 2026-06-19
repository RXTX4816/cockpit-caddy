import { useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  FormGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ProxyEntry } from "../api";

interface Props {
  proxy: ProxyEntry;
  onSave: (entry: ProxyEntry) => Promise<void>;
  onDelete: (serverKey: string) => Promise<void>;
  onClose: () => void;
}

export function EditProxyDialog({ proxy, onSave, onDelete, onClose }: Props) {
  const { t } = useTranslation();
  const [targetHost, setTargetHost] = useState(proxy.targetHost);
  const [targetPort, setTargetPort] = useState(String(proxy.targetPort));
  const [tls, setTls] = useState(proxy.tls);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        ...proxy,
        targetHost: targetHost.trim(),
        targetPort: parseInt(targetPort, 10),
        tls,
        label: label.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete(proxy.serverKey);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} aria-label={t("edit_proxy.aria_label")} variant="small">
      <ModalHeader title={t("edit_proxy.title", { port: proxy.externalPort })} />
      <ModalBody>
        <Form>
          <FormGroup label={t("add_proxy.field_target_host")} fieldId="edit-target-host">
            <TextInput
              id="edit-target-host"
              value={targetHost}
              onChange={(_e, v) => setTargetHost(v)}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_target_port")} fieldId="edit-target-port">
            <TextInput
              id="edit-target-port"
              type="number"
              value={targetPort}
              onChange={(_e, v) => setTargetPort(v)}
            />
          </FormGroup>

          <FormGroup fieldId="edit-tls">
            <Checkbox
              id="edit-tls"
              label={t("add_proxy.field_tls")}
              isChecked={tls}
              onChange={(_e, checked) => setTls(checked)}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_label")} fieldId="edit-label">
            <TextInput
              id="edit-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
            />
          </FormGroup>

          {saveError && <div style={{ color: "var(--pf-v6-global--danger-color--100)" }}>{saveError}</div>}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={handleSave} isLoading={saving} isDisabled={saving || deleting}>
          {t("edit_proxy.save_button")}
        </Button>
        <Button variant="danger" onClick={handleDelete} isLoading={deleting} isDisabled={saving || deleting}>
          {t("common.delete")}
        </Button>
        <Button variant="link" onClick={onClose} isDisabled={saving || deleting}>
          {t("common.cancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
