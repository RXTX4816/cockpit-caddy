import { useState, useEffect, useRef } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  InputGroup,
  InputGroupText,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import type { ProxyEntry } from "../api";

interface Props {
  proxy: ProxyEntry;
  existingPorts: number[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
}

export function EditProxyDialog({ proxy, existingPorts, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const saveConfirm = useConfirmAction();
  const [externalPort, setExternalPort] = useState(String(proxy.externalPort));
  const [targetScheme, setTargetScheme] = useState<"http" | "https">(proxy.targetScheme);
  const [targetHost, setTargetHost] = useState(proxy.targetHost);
  const [targetPort, setTargetPort] = useState(String(proxy.targetPort));
  const [tls, setTls] = useState(proxy.tls);
  const [tlsSkipVerify, setTlsSkipVerify] = useState(proxy.tlsSkipVerify);
  const [label, setLabel] = useState(proxy.label ?? "");

  function portError(): string | null {
    const n = parseInt(externalPort, 10);
    if (!externalPort || isNaN(n)) return t("add_proxy.validation_port_number");
    if (n < 1 || n > 65535) return t("add_proxy.validation_port_range");
    if (existingPorts.includes(n)) return t("add_proxy.validation_port_duplicate", { port: n });
    return null;
  }

  const portErr = portError();
  const isConfirming = saveConfirm.step !== "idle";
  const isBusy = saveConfirm.step === "submitting";

  const warningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isConfirming) warningRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [isConfirming]);

  const extProto = tls ? "https" : "http";
  const extUrl = `${extProto}://…:${externalPort || "…"}`;
  const targetUrl = `${targetScheme}://${targetHost || "…"}:${targetPort || "…"}`;

  return (
    <Modal isOpen onClose={onClose} aria-label={t("edit_proxy.aria_label")} variant="medium">
      <ModalHeader title={t("edit_proxy.title", { port: proxy.externalPort })} />
      <ModalBody>
        <div ref={warningRef} />
        {isConfirming && (
          <Alert
            variant="warning"
            isInline
            title={t("edit_proxy.confirm_save_body", { port: externalPort })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <div style={{
          marginBottom: "var(--pf-v6-global--spacer--md)",
          padding: "0.5rem 0.75rem",
          background: "var(--pf-t--global--background--color--secondary--default)",
          borderRadius: "var(--pf-t--global--border--radius--100, 4px)",
          fontFamily: "monospace",
          fontSize: "0.85rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}>
          <Label isCompact color={tls ? "blue" : "grey"}>{extUrl}</Label>
          <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>→</span>
          <Label isCompact color="grey">{targetUrl}</Label>
        </div>

        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="edit-label">
            <TextInput
              id="edit-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isConfirming}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_external_port")} fieldId="edit-external-port" isRequired>
            <InputGroup>
              <InputGroupText>:</InputGroupText>
              <TextInput
                id="edit-external-port"
                type="number"
                value={externalPort}
                onChange={(_e, v) => setExternalPort(v)}
                validated={portErr ? "error" : "default"}
                isDisabled={isConfirming}
              />
            </InputGroup>
            {portErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{portErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_proxy.field_target_host")} fieldId="edit-target-host" isRequired>
            <InputGroup>
              <div style={{ display: "flex", gap: 0, width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <Button
                    variant={targetScheme === "http" ? "primary" : "plain"}
                    size="sm"
                    onClick={() => setTargetScheme("http")}
                    isDisabled={isConfirming}
                  >http</Button>
                  <Button
                    variant={targetScheme === "https" ? "primary" : "plain"}
                    size="sm"
                    onClick={() => setTargetScheme("https")}
                    isDisabled={isConfirming}
                  >https</Button>
                </div>
                <TextInput
                  id="edit-target-host"
                  value={targetHost}
                  onChange={(_e, v) => setTargetHost(v)}
                  isDisabled={isConfirming}
                  style={{ flex: 1 }}
                />
                <InputGroupText>:</InputGroupText>
                <TextInput
                  id="edit-target-port"
                  type="number"
                  value={targetPort}
                  onChange={(_e, v) => setTargetPort(v)}
                  isDisabled={isConfirming}
                  style={{ width: 90 }}
                />
              </div>
            </InputGroup>
            {targetScheme === "https" && (
              <Checkbox
                id="edit-tls-skip-verify"
                label={t("add_proxy.field_tls_skip_verify")}
                isChecked={tlsSkipVerify}
                onChange={(_e, checked) => setTlsSkipVerify(checked)}
                isDisabled={isConfirming}
                style={{ marginTop: "0.4rem" }}
              />
            )}
          </FormGroup>

          <FormGroup label={t("add_proxy.field_tls")} fieldId="edit-tls">
            <Checkbox
              id="edit-tls"
              label={t("add_proxy.field_tls_short")}
              isChecked={tls}
              onChange={(_e, checked) => setTls(checked)}
              isDisabled={isConfirming}
            />
          </FormGroup>
        </Form>

        {saveConfirm.error && (
          <Alert variant="danger" isInline title={saveConfirm.error} style={{ marginTop: "var(--pf-v6-global--spacer--md)" }} />
        )}
      </ModalBody>
      <ModalFooter>
        {isConfirming ? (
          <>
            <Button
              variant="primary"
              isLoading={isBusy}
              isDisabled={isBusy}
              onClick={() => void saveConfirm.submit(async () => {
                const port = parseInt(externalPort, 10);
                await onSave({
                  ...proxy,
                  externalPort: port,
                  id: String(port),
                  targetScheme,
                  targetHost: targetHost.trim(),
                  targetPort: parseInt(targetPort, 10),
                  tls,
                  tlsSkipVerify: targetScheme === "https" ? tlsSkipVerify : false,
                  label: label.trim() || undefined,
                });
                toast.success(t("toast.proxy_saved", { port: externalPort }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={saveConfirm.cancel} isDisabled={isBusy}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={saveConfirm.confirm} isDisabled={!!portErr}>
              {t("edit_proxy.save_button")}
            </Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
