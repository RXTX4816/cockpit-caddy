import { useState } from "react";
import {
  Alert,
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
  Radio,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import type { ProxyEntry } from "../api";

interface FormState {
  externalPort: string;
  targetHost: string;
  targetPort: string;
  targetScheme: "http" | "https";
  tls: boolean;
  tlsSkipVerify: boolean;
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
  const toast = useToast();
  const confirmAction = useConfirmAction();
  const [form, setForm] = useState<FormState>({
    externalPort: "",
    targetHost: "localhost",
    targetPort: "",
    targetScheme: "http",
    tls: true,
    tlsSkipVerify: false,
    label: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});

  function validate(): FormErrors {
    const errs: FormErrors = {};
    const port = parseInt(form.externalPort, 10);

    if (!form.externalPort) {
      errs.externalPort = t("add_proxy.validation_port_required");
    } else if (isNaN(port)) {
      errs.externalPort = t("add_proxy.validation_port_number");
    } else if (port < 1 || port > 65535) {
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

  function handleAddClick() {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    confirmAction.confirm();
  }

  const target = `${form.targetScheme}://${form.targetHost || "…"}:${form.targetPort || "…"}`;
  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_proxy.aria_label")} variant="small">
      <ModalHeader title={t("add_proxy.title")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("add_proxy.confirm_body", { port: form.externalPort, target })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}
        <Form>
          <FormGroup label={t("add_proxy.field_external_port")} fieldId="external-port" isRequired>
            <TextInput
              id="external-port"
              type="number"
              value={form.externalPort}
              onChange={(_e, v) => set("externalPort", v)}
              placeholder="8443"
              isDisabled={isLocked}
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

          <FormGroup label={t("add_proxy.field_target_scheme")} fieldId="target-scheme" role="radiogroup">
            <Radio
              id="scheme-http"
              name="target-scheme"
              label="HTTP"
              value="http"
              isChecked={form.targetScheme === "http"}
              onChange={() => set("targetScheme", "http")}
              isDisabled={isLocked}
            />
            <Radio
              id="scheme-https"
              name="target-scheme"
              label="HTTPS"
              value="https"
              isChecked={form.targetScheme === "https"}
              onChange={() => set("targetScheme", "https")}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_target_host")} fieldId="target-host" isRequired>
            <TextInput
              id="target-host"
              value={form.targetHost}
              onChange={(_e, v) => set("targetHost", v)}
              placeholder={t("add_proxy.field_target_host_placeholder")}
              isDisabled={isLocked}
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
              isDisabled={isLocked}
            />
            {errors.targetPort && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">{errors.targetPort}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          {form.targetScheme === "https" && (
            <FormGroup fieldId="tls-skip-verify">
              <Checkbox
                id="tls-skip-verify"
                label={t("add_proxy.field_tls_skip_verify")}
                isChecked={form.tlsSkipVerify}
                onChange={(_e, checked) => set("tlsSkipVerify", checked)}
                isDisabled={isLocked}
              />
            </FormGroup>
          )}

          <FormGroup fieldId="tls">
            <Checkbox
              id="tls"
              label={t("add_proxy.field_tls")}
              isChecked={form.tls}
              onChange={(_e, checked) => set("tls", checked)}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_label")} fieldId="label">
            <TextInput
              id="label"
              value={form.label}
              onChange={(_e, v) => set("label", v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>
        </Form>

        {confirmAction.error && (
          <Alert
            variant="danger"
            isInline
            title={confirmAction.error}
            style={{ marginTop: "var(--pf-v6-global--spacer--md)" }}
          />
        )}
      </ModalBody>
      <ModalFooter>
        {isLocked ? (
          <>
            <Button
              variant="primary"
              onClick={() => void confirmAction.submit(async () => {
                await onAdd({
                  externalPort: parseInt(form.externalPort, 10),
                  targetHost: form.targetHost.trim(),
                  targetPort: parseInt(form.targetPort, 10),
                  targetScheme: form.targetScheme,
                  tls: form.tls,
                  tlsSkipVerify: form.targetScheme === "https" ? form.tlsSkipVerify : false,
                  label: form.label.trim() || undefined,
                });
                toast.success(t("toast.proxy_added", { port: form.externalPort }));
                onClose();
              })}
              isLoading={isSaving}
              isDisabled={isSaving}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>
              {t("common.back")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAddClick}>
              {t("add_proxy.add_button")}
            </Button>
            <Button variant="link" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
