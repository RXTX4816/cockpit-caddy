import { useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ProxyEntry } from "../api";

interface FormState {
  externalPort: string;
  targetHost: string;
  targetPort: string;
  tls: boolean;
  label: string;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
}

export function AddProxyDialog({ existingPorts, onAdd, onClose }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>({
    externalPort: "",
    targetHost: "localhost",
    targetPort: "",
    tls: true,
    label: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function validate(): FormErrors {
    const errs: FormErrors = {};
    const port = parseInt(form.externalPort, 10);

    if (!form.externalPort) {
      errs.externalPort = t("add_proxy.validation_port_required");
    } else if (isNaN(port)) {
      errs.externalPort = t("add_proxy.validation_port_number");
    } else if (port < 1024 || port > 65535) {
      errs.externalPort = t("add_proxy.validation_port_range");
    } else if (existingPorts.includes(port)) {
      errs.externalPort = t("add_proxy.validation_port_duplicate", { port });
    }

    if (!form.targetHost.trim()) {
      errs.targetHost = t("add_proxy.validation_target_host_required");
    }

    const tport = parseInt(form.targetPort, 10);
    if (!form.targetPort) {
      errs.targetPort = t("add_proxy.validation_target_port_required");
    } else if (isNaN(tport) || tport < 1 || tport > 65535) {
      errs.targetPort = t("add_proxy.validation_target_port_range");
    }

    return errs;
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  async function handleAdd() {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await onAdd({
        externalPort: parseInt(form.externalPort, 10),
        targetHost: form.targetHost.trim(),
        targetPort: parseInt(form.targetPort, 10),
        tls: form.tls,
        label: form.label.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t("add_proxy.error_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_proxy.aria_label")} variant="small">
      <ModalHeader title={t("add_proxy.title")} />
      <ModalBody>
        <Form>
          <FormGroup label={t("add_proxy.field_external_port")} fieldId="external-port" isRequired>
            <TextInput
              id="external-port"
              type="number"
              value={form.externalPort}
              onChange={(_e, v) => set("externalPort", v)}
              placeholder="8443"
            />
            <FormHelperText>
              <HelperText>
                {errors.externalPort ? (
                  <HelperTextItem variant="error">{errors.externalPort}</HelperTextItem>
                ) : (
                  <HelperTextItem>{t("add_proxy.field_external_port_help")}</HelperTextItem>
                )}
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t("add_proxy.field_target_host")} fieldId="target-host" isRequired>
            <TextInput
              id="target-host"
              value={form.targetHost}
              onChange={(_e, v) => set("targetHost", v)}
              placeholder={t("add_proxy.field_target_host_placeholder")}
            />
            {errors.targetHost && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">{errors.targetHost}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_proxy.field_target_port")} fieldId="target-port" isRequired>
            <TextInput
              id="target-port"
              type="number"
              value={form.targetPort}
              onChange={(_e, v) => set("targetPort", v)}
              placeholder="8080"
            />
            {errors.targetPort && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">{errors.targetPort}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup fieldId="tls">
            <Checkbox
              id="tls"
              label={t("add_proxy.field_tls")}
              isChecked={form.tls}
              onChange={(_e, checked) => set("tls", checked)}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_label")} fieldId="label">
            <TextInput
              id="label"
              value={form.label}
              onChange={(_e, v) => set("label", v)}
              placeholder={t("add_proxy.field_label_placeholder")}
            />
          </FormGroup>

          {saveError && (
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant="error">{saveError}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={handleAdd} isLoading={saving} isDisabled={saving}>
          {t("add_proxy.add_button")}
        </Button>
        <Button variant="link" onClick={onClose} isDisabled={saving}>
          {t("common.cancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
