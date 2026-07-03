import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
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
import type { ProxyEntry, RouteMatch, ServerDef } from "../api";
import { RouteMatchersSection } from "./RouteMatchersSection";
import { parseListenPort } from "./AddServerDialog";
import type { ServerContext } from "./AddRedirectDialog";

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  initialValues?: { port?: string; statusCode?: string; body?: string; close?: boolean; label?: string };
  initialMatchers?: RouteMatch;
  initialHandlePath?: boolean;
  servers?: ServerDef[];
  initialServerKey?: string;
}

export function AddRespondDialog({ existingPorts, onAdd, onClose, initialValues, initialMatchers, initialHandlePath, servers, initialServerKey }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(initialValues?.port ?? "");
  const [statusCode, setStatusCode] = useState(initialValues?.statusCode ?? "200");
  const [body, setBody] = useState(initialValues?.body ?? "");
  const [close, setClose] = useState(initialValues?.close ?? false);
  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [matchers, setMatchers] = useState<RouteMatch | undefined>(initialMatchers);
  const [handlePath, setHandlePath] = useState(initialHandlePath ?? false);
  const [selectedServerKey, setSelectedServerKey] = useState(initialServerKey ?? "");
  const [portErr, setPortErr] = useState<string | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const selectedServer = servers?.find(s => s.key === selectedServerKey);
  const serverCtx: ServerContext | undefined = selectedServer ? {
    serverKey: selectedServer.key,
    serverName: selectedServer.name,
    port: parseListenPort(selectedServer.listenAddresses[0] ?? ":443"),
  } : undefined;

  function validate(): boolean {
    let ok = true;
    if (!serverCtx) {
      const n = parseInt(port, 10);
      if (!port) { setPortErr(t("add_respond.validation_port_required")); ok = false; }
      else if (isNaN(n)) { setPortErr(t("add_respond.validation_port_number")); ok = false; }
      else if (n < 1 || n > 65535) { setPortErr(t("add_respond.validation_port_range")); ok = false; }
      else if (existingPorts.includes(n)) { setPortErr(t("add_respond.validation_port_duplicate", { port: n })); ok = false; }
      else setPortErr(null);
    }

    const sc = parseInt(statusCode, 10);
    if (!statusCode) { setStatusErr(t("add_respond.validation_status_required")); ok = false; }
    else if (isNaN(sc) || sc < 100 || sc > 599) { setStatusErr(t("add_respond.validation_status_range")); ok = false; }
    else setStatusErr(null);

    return ok;
  }

  function handleAdd() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_respond.aria_label")} variant="medium">
      <ModalHeader title={t("add_respond.title")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("add_respond.confirm_body", { port: serverCtx ? serverCtx.port : port, status: statusCode })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}
        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="respond-label">
            <TextInput
              id="respond-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>

          {servers && servers.length > 0 && (
            <FormGroup label={t("servers.selector_label")} fieldId="respond-server">
              <FormSelect
                id="respond-server"
                value={selectedServerKey}
                onChange={(_e, v) => { setSelectedServerKey(v); setPortErr(null); }}
                isDisabled={isLocked}
              >
                <FormSelectOption value="" label={t("servers.selector_none")} />
                {servers.map(s => (
                  <FormSelectOption key={s.key} value={s.key} label={`${s.name} (${s.listenAddresses[0] ?? ""})`} />
                ))}
              </FormSelect>
            </FormGroup>
          )}

          {serverCtx ? (
            <FormGroup label={t("add_redirect.field_from_port")} fieldId="respond-port">
              <Label isCompact color="blue">{serverCtx.serverName} (:{serverCtx.port})</Label>
            </FormGroup>
          ) : (
            <FormGroup label={t("add_redirect.field_from_port")} fieldId="respond-port" isRequired>
              <TextInput
                id="respond-port"
                type="number"
                value={port}
                onChange={(_e, v) => { setPort(v); setPortErr(null); }}
                placeholder="8080"
                isDisabled={isLocked}
                validated={portErr ? "error" : "default"}
              />
              {portErr && (
                <FormHelperText>
                  <HelperText><HelperTextItem variant="error">{portErr}</HelperTextItem></HelperText>
                </FormHelperText>
              )}
            </FormGroup>
          )}

          <FormGroup label={t("add_respond.field_status")} fieldId="respond-status" isRequired>
            <TextInput
              id="respond-status"
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

          <FormGroup label={t("add_respond.field_body")} fieldId="respond-body">
            <TextArea
              id="respond-body"
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

          <FormGroup fieldId="respond-close">
            <Checkbox
              id="respond-close"
              label={t("add_respond.field_close")}
              isChecked={close}
              onChange={(_e, v) => setClose(v)}
              isDisabled={isLocked}
            />
          </FormGroup>
        </Form>
        <RouteMatchersSection value={matchers} onChange={v => { setMatchers(v); if (!v?.path?.length) setHandlePath(false); }} isDisabled={isLocked} />
        {matchers?.path?.length && !matchers.host?.length && !matchers.method?.length && !matchers.header && !matchers.query && !matchers.remote_ip && (
          <Checkbox
            id="add-respond-handle-path"
            label={t("handle_path.label")}
            isChecked={handlePath}
            onChange={(_e, v) => setHandlePath(v)}
            isDisabled={isLocked}
            style={{ marginLeft: "1rem", marginBottom: "0.5rem" }}
          />
        )}

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
                    externalPort: serverCtx ? serverCtx.port : parseInt(port, 10),
                    externalScheme: undefined,
                    externalHost: undefined,
                    targetHost: "localhost",
                    targetPort: 0,
                    targetScheme: "http",
                    tls: false,
                    tlsSkipVerify: false,
                    label: label.trim() || undefined,
                    staticResponse: {
                      statusCode: parseInt(statusCode, 10),
                      body: body.trim() || undefined,
                      close: close || undefined,
                    },
                    matchers: matchers ?? undefined,
                    handlePath: handlePath || undefined,
                    namedServerKey: serverCtx?.serverKey,
                  });
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_add_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_added", { port: serverCtx ? serverCtx.port : port }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAdd}>{t("add_respond.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
