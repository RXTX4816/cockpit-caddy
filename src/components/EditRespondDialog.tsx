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
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import type { ProxyEntry } from "../api";

interface Props {
  proxy: ProxyEntry;
  existingPorts?: number[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
}

export function EditRespondDialog({ proxy, existingPorts: _existingPorts, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [statusCode, setStatusCode] = useState(String(proxy.staticResponse?.statusCode ?? 200));
  const [body, setBody] = useState(proxy.staticResponse?.body ?? "");
  const [close, setClose] = useState(proxy.staticResponse?.close ?? false);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [statusErr, setStatusErr] = useState<string | null>(null);

  function validate(): boolean {
    const sc = parseInt(statusCode, 10);
    if (!statusCode || isNaN(sc) || sc < 100 || sc > 599) {
      setStatusErr(t("add_respond.validation_status_range"));
      return false;
    }
    setStatusErr(null);
    return true;
  }

  function handleSave() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("edit_respond.aria_label")} variant="medium">
      <ModalHeader title={t("edit_respond.title", { port: proxy.externalPort })} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("edit_respond.confirm_body", { port: proxy.externalPort, status: statusCode })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}
        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="er-label">
            <TextInput
              id="er-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("add_respond.field_status")} fieldId="er-status" isRequired>
            <TextInput
              id="er-status"
              type="number"
              value={statusCode}
              onChange={(_e, v) => { setStatusCode(v); setStatusErr(null); }}
              placeholder="200"
              isDisabled={isLocked}
              validated={statusErr ? "error" : "default"}
            />
            {statusErr ? (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{statusErr}</HelperTextItem></HelperText>
              </FormHelperText>
            ) : (
              <FormHelperText>
                <HelperText><HelperTextItem>{t("add_respond.field_status_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_respond.field_body")} fieldId="er-body">
            <TextArea
              id="er-body"
              value={body}
              onChange={(_e, v) => setBody(v)}
              placeholder={t("add_respond.field_body_placeholder")}
              isDisabled={isLocked}
              rows={4}
              resizeOrientation="vertical"
            />
            <FormHelperText>
              <HelperText><HelperTextItem>{t("add_respond.field_body_help")}</HelperTextItem></HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup fieldId="er-close">
            <Checkbox
              id="er-close"
              label={t("add_respond.field_close")}
              isChecked={close}
              onChange={(_e, v) => setClose(v)}
              isDisabled={isLocked}
            />
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
                  await onSave({
                    ...proxy,
                    label: label.trim() || undefined,
                    staticResponse: {
                      statusCode: parseInt(statusCode, 10),
                      body: body.trim() || undefined,
                      close: close || undefined,
                    },
                  });
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_edit_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_saved", { port: proxy.externalPort }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleSave}>{t("edit_respond.save_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
