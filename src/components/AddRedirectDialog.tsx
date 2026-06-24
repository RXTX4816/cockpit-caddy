import { useState } from "react";
import {
  Alert,
  Button,
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
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import type { ProxyEntry } from "../api";

const REDIRECT_CODES = [301, 302, 307, 308] as const;

interface InitialValues {
  port?: string;
  to?: string;
  code?: 301 | 302 | 307 | 308;
  label?: string;
}

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  initialValues?: InitialValues;
}

export function AddRedirectDialog({ existingPorts, onAdd, onClose, initialValues }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(initialValues?.port ?? "");
  const [to, setTo] = useState(initialValues?.to ?? "");
  const [code, setCode] = useState<301 | 302 | 307 | 308>(initialValues?.code ?? 308);
  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [portErr, setPortErr] = useState<string | null>(null);
  const [toErr, setToErr] = useState<string | null>(null);

  function applyHttpsShortcut() {
    setPort("80");
    setTo("https://{host}{uri}");
    setCode(308);
    setPortErr(null);
    setToErr(null);
  }

  function validate(): boolean {
    let ok = true;
    const n = parseInt(port, 10);
    if (!port) { setPortErr(t("add_redirect.validation_port_required")); ok = false; }
    else if (isNaN(n)) { setPortErr(t("add_redirect.validation_port_number")); ok = false; }
    else if (n < 1 || n > 65535) { setPortErr(t("add_redirect.validation_port_range")); ok = false; }
    else if (existingPorts.includes(n)) { setPortErr(t("add_redirect.validation_port_duplicate", { port: n })); ok = false; }
    else setPortErr(null);

    if (!to.trim()) { setToErr(t("add_redirect.validation_to_required")); ok = false; }
    else setToErr(null);

    return ok;
  }

  function handleAdd() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_redirect.aria_label")} variant="medium">
      <ModalHeader title={t("add_redirect.title")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("add_redirect.confirm_body", { port, to, code })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <div style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
          <Button variant="secondary" size="sm" onClick={applyHttpsShortcut} isDisabled={isLocked}>
            {t("add_redirect.shortcut_http_https")}
          </Button>
          <div style={{ fontSize: "0.8rem", color: "var(--pf-t--global--text--color--subtle)", marginTop: "0.25rem" }}>
            {t("add_redirect.shortcut_http_https_help")}
          </div>
        </div>

        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="redirect-label">
            <TextInput
              id="redirect-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("add_redirect.field_from_port")} fieldId="redirect-port" isRequired>
            <TextInput
              id="redirect-port"
              type="number"
              value={port}
              onChange={(_e, v) => { setPort(v); setPortErr(null); }}
              placeholder="80"
              isDisabled={isLocked}
              validated={portErr ? "error" : "default"}
            />
            {portErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{portErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_redirect.field_to_url")} fieldId="redirect-to" isRequired>
            <TextInput
              id="redirect-to"
              value={to}
              onChange={(_e, v) => { setTo(v); setToErr(null); }}
              placeholder="https://{host}{uri}"
              isDisabled={isLocked}
              validated={toErr ? "error" : "default"}
            />
            {toErr ? (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{toErr}</HelperTextItem></HelperText>
              </FormHelperText>
            ) : (
              <FormHelperText>
                <HelperText><HelperTextItem>{t("add_redirect.field_to_url_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_redirect.field_code")} fieldId="redirect-code" isRequired>
            <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
              {REDIRECT_CODES.map(c => (
                <Button
                  key={c}
                  variant={code === c ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setCode(c)}
                  isDisabled={isLocked}
                >
                  {t(`add_redirect.code_${c}`)}
                </Button>
              ))}
            </div>
          </FormGroup>
        </Form>

        {confirmAction.error && (
          <Alert variant="danger" isInline title={confirmAction.error} style={{ marginTop: "var(--pf-v6-global--spacer--md)" }} />
        )}
      </ModalBody>
      <ModalFooter>
        {isLocked ? (
          <>
            <Button
              variant="primary"
              isLoading={isSaving}
              isDisabled={isSaving}
              onClick={() => void confirmAction.submit(async () => {
                try {
                  await onAdd({
                    externalPort: parseInt(port, 10),
                    externalScheme: undefined,
                    externalHost: undefined,
                    targetHost: "localhost",
                    targetPort: 0,
                    targetScheme: "http",
                    tls: false,
                    tlsSkipVerify: false,
                    label: label.trim() || undefined,
                    redirect: { to: to.trim(), code },
                  });
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_add_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_added", { port }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAdd}>{t("add_redirect.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
