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
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import { SectionActions } from "./SectionActions";
import type { ProxyEntry, ErrorHandlerConfig } from "../api";
import { BasicAuthSection, resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { AccessLogSection, type AccessLogValues, accessLogConfigToValues, accessLogValuesToConfig } from "./AccessLogSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsConfigToValues } from "./TlsSection";

interface Props {
  proxy: ProxyEntry;
  existingPorts: number[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
}

export function EditStaticDialog({ proxy, existingPorts, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(String(proxy.externalPort));
  const [root, setRoot] = useState(proxy.fileServer?.root ?? "");
  const [browse, setBrowse] = useState(proxy.fileServer?.browse ?? false);
  const [tls, setTls] = useState(proxy.tls);
  const [compress, setCompress] = useState(proxy.compress ?? false);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(
    (proxy.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash })),
  );
  const [responseHeaders, setResponseHeaders] = useState(proxy.responseHeaders ?? []);
  const [requestHeaders, setRequestHeaders] = useState(proxy.requestHeaders);
  const [accessLog, setAccessLog] = useState<AccessLogValues>(accessLogConfigToValues(proxy.accessLog));
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>({
    readTimeout: proxy.serverReadTimeout ?? "",
    readHeaderTimeout: proxy.serverReadHeaderTimeout ?? "",
    writeTimeout: proxy.serverWriteTimeout ?? "",
    idleTimeout: proxy.serverIdleTimeout ?? "",
    maxHeaderBytes: proxy.maxHeaderBytes != null ? String(proxy.maxHeaderBytes) : "",
  });
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(proxy.errorHandlers ?? []);
  const [tlsValues, setTlsValues] = useState<TlsValues>(tlsConfigToValues(proxy.tlsAdvanced, proxy.mtls));
  const [portErr, setPortErr] = useState<string | null>(null);
  const [rootErr, setRootErr] = useState<string | null>(null);

  function validate(): boolean {
    let ok = true;
    const n = parseInt(port, 10);
    if (!port) { setPortErr(t("add_static.validation_port_required")); ok = false; }
    else if (isNaN(n)) { setPortErr(t("add_static.validation_port_number")); ok = false; }
    else if (n < 1 || n > 65535) { setPortErr(t("add_static.validation_port_range")); ok = false; }
    else if (existingPorts.includes(n)) { setPortErr(t("add_static.validation_port_duplicate", { port: n })); ok = false; }
    else setPortErr(null);

    if (!root.trim()) { setRootErr(t("add_static.validation_root_required")); ok = false; }
    else setRootErr(null);

    return ok;
  }

  function handleSave() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("edit_static.aria_label")} variant="medium">
      <ModalHeader title={t("edit_static.title", { port: proxy.externalPort })} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("edit_static.confirm_body", { port })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="static-edit-label">
            <TextInput
              id="static-edit-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("add_redirect.field_from_port")} fieldId="static-edit-port" isRequired>
            <TextInput
              id="static-edit-port"
              type="number"
              value={port}
              onChange={(_e, v) => { setPort(v); setPortErr(null); }}
              isDisabled={isLocked}
              validated={portErr ? "error" : "default"}
            />
            {portErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{portErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_static.field_root")} fieldId="static-edit-root" isRequired>
            <TextInput
              id="static-edit-root"
              value={root}
              onChange={(_e, v) => { setRoot(v); setRootErr(null); }}
              placeholder={t("add_static.field_root_placeholder")}
              isDisabled={isLocked}
              validated={rootErr ? "error" : "default"}
            />
            {rootErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{rootErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup fieldId="static-edit-browse">
            <Checkbox
              id="static-edit-browse"
              label={t("add_static.field_browse")}
              isChecked={browse}
              onChange={(_e, v) => setBrowse(v)}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup fieldId="static-edit-tls">
            <Checkbox
              id="static-edit-tls"
              label={t("add_proxy.field_tls_short")}
              isChecked={tls}
              onChange={(_e, v) => setTls(v)}
              isDisabled={isLocked}
            />
            <SectionActions onDefaults={() => setTls(true)} isDisabled={isLocked} />
          </FormGroup>

          <FormGroup fieldId="static-edit-compress">
            <Checkbox
              id="static-edit-compress"
              label={t("add_proxy.field_compress_short")}
              isChecked={compress}
              onChange={(_e, v) => setCompress(v)}
              isDisabled={isLocked}
            />
          </FormGroup>
        </Form>

        <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} />
        <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} />
        <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} />
        <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} />
        <BasicAuthSection
          value={basicAuth}
          onChange={setBasicAuth}
          isDisabled={isLocked}
        />
        <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isLocked} />
        <ResponseHeadersSection
          value={responseHeaders}
          onChange={v => setResponseHeaders(v ?? [])}
          isDisabled={isLocked}
        />

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
                const resolvedAuth = await resolveBasicAuth(basicAuth);
                try {
                  await onSave({
                    ...proxy,
                    externalPort: parseInt(port, 10),
                    tls,
                    compress: compress || undefined,
                    label: label.trim() || undefined,
                    fileServer: { root: root.trim(), browse: browse || undefined },
                    basicAuth: resolvedAuth.length ? resolvedAuth : undefined,
                    requestHeaders: requestHeaders ?? undefined,
                    responseHeaders: responseHeaders.length ? responseHeaders : undefined,
                    accessLog: accessLogValuesToConfig(accessLog),
                    errorHandlers: errorHandlers.length ? errorHandlers : undefined,
                    serverReadTimeout: serverTimeouts.readTimeout.trim() || undefined,
                    serverReadHeaderTimeout: serverTimeouts.readHeaderTimeout.trim() || undefined,
                    serverWriteTimeout: serverTimeouts.writeTimeout.trim() || undefined,
                    serverIdleTimeout: serverTimeouts.idleTimeout.trim() || undefined,
                    maxHeaderBytes: serverTimeouts.maxHeaderBytes.trim() ? parseInt(serverTimeouts.maxHeaderBytes, 10) : undefined,
                    tlsAdvanced: tlsValuesToAdvanced(tlsValues),
                    mtls: tlsValuesToMtls(tlsValues),
                  });
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_edit_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_saved", { port }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleSave}>{t("edit_static.save_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
