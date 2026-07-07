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
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import { SectionActions } from "./SectionActions";
import type { ProxyEntry, HeaderOperation, ErrorHandlerConfig, RouteMatch } from "../api";
import { RouteMatchersSection } from "./RouteMatchersSection";
import { BasicAuthSection, resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { AccessLogSection, type AccessLogValues, accessLogConfigToValues, accessLogValuesToConfig } from "./AccessLogSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { RequestBodyLimitField } from "./RequestBodyLimitField";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsConfigToValues } from "./TlsSection";
import { sectionAccordionProps } from "./sectionAccordion";
import { AccordionRow } from "./AccordionRow";

import type { ServerContext } from "./AddRedirectDialog";
import { parseListenPort } from "./AddServerDialog";

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  initialValues?: { port?: string; root?: string; browse?: boolean; tls?: boolean; compress?: boolean; label?: string };
  initialBasicAuth?: AuthEntry[];
  initialResponseHeaders?: HeaderOperation[];
  initialRequestHeaders?: HeaderOperation[];
  initialAccessLog?: AccessLogValues;
  initialServerTimeouts?: ServerTimeoutValues;
  initialRequestBodyMaxSize?: string;
  initialErrorHandlers?: ErrorHandlerConfig[];
  initialTlsValues?: TlsValues;
  initialMatchers?: RouteMatch;
  initialHandlePath?: boolean;
  servers?: import("../api").ServerDef[];
  initialServerKey?: string;
}

export function AddStaticDialog({ existingPorts, onAdd, onClose, initialValues, initialBasicAuth, initialResponseHeaders, initialRequestHeaders, initialAccessLog, initialServerTimeouts, initialRequestBodyMaxSize, initialErrorHandlers, initialTlsValues, initialMatchers, initialHandlePath, servers, initialServerKey }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(initialValues?.port ?? "");
  const [root, setRoot] = useState(initialValues?.root ?? "");
  const [browse, setBrowse] = useState(initialValues?.browse ?? false);
  const [tls, setTls] = useState(initialValues?.tls ?? true);
  const [compress, setCompress] = useState(initialValues?.compress ?? false);
  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(initialBasicAuth ?? []);
  const [responseHeaders, setResponseHeaders] = useState<HeaderOperation[]>(initialResponseHeaders ?? []);
  const [requestHeaders, setRequestHeaders] = useState<HeaderOperation[] | undefined>(initialRequestHeaders);
  const [accessLog, setAccessLog] = useState<AccessLogValues>(initialAccessLog ?? accessLogConfigToValues(undefined));
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>(initialServerTimeouts ?? { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false });
  const [requestBodyMaxSize, setRequestBodyMaxSize] = useState(initialRequestBodyMaxSize ?? "");
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(initialErrorHandlers ?? []);
  const [tlsValues, setTlsValues] = useState<TlsValues>(initialTlsValues ?? tlsConfigToValues(undefined, undefined));
  const [matchers, setMatchers] = useState<RouteMatch | undefined>(initialMatchers);
  const [handlePath, setHandlePath] = useState(initialHandlePath ?? false);
  const [selectedServerKey, setSelectedServerKey] = useState(initialServerKey ?? "");
  const [portErr, setPortErr] = useState<string | null>(null);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

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
      if (!port) { setPortErr(t("add_static.validation_port_required")); ok = false; }
      else if (isNaN(n)) { setPortErr(t("add_static.validation_port_number")); ok = false; }
      else if (n < 1 || n > 65535) { setPortErr(t("add_static.validation_port_range")); ok = false; }
      else if (existingPorts.includes(n)) { setPortErr(t("add_static.validation_port_duplicate", { port: n })); ok = false; }
      else setPortErr(null);
    }

    if (!root.trim()) { setRootErr(t("add_static.validation_root_required")); ok = false; }
    else setRootErr(null);

    return ok;
  }

  function handleAdd() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_static.aria_label")} variant="medium">
      <ModalHeader title={t("add_static.title")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("add_static.confirm_body", { port: serverCtx ? serverCtx.port : port, root: root.trim() })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="static-label">
            <TextInput
              id="static-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>

          {servers && servers.length > 0 && (
            <FormGroup label={t("servers.selector_label")} fieldId="static-server">
              <FormSelect
                id="static-server"
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
            <FormGroup label={t("add_redirect.field_from_port")} fieldId="static-port">
              <Label isCompact color="blue">{serverCtx.serverName} (:{serverCtx.port})</Label>
            </FormGroup>
          ) : (
            <FormGroup label={t("add_redirect.field_from_port")} fieldId="static-port" isRequired>
              <TextInput
                id="static-port"
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

          <FormGroup label={t("add_static.field_root")} fieldId="static-root" isRequired>
            <TextInput
              id="static-root"
              value={root}
              onChange={(_e, v) => { setRoot(v); setRootErr(null); }}
              placeholder={t("add_static.field_root_placeholder")}
              isDisabled={isLocked}
              validated={rootErr ? "error" : "default"}
            />
            {rootErr ? (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{rootErr}</HelperTextItem></HelperText>
              </FormHelperText>
            ) : (
              <FormHelperText>
                <HelperText><HelperTextItem>{t("add_static.field_root_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup fieldId="static-browse">
            <Checkbox
              id="static-browse"
              label={t("add_static.field_browse")}
              isChecked={browse}
              onChange={(_e, v) => setBrowse(v)}
              isDisabled={isLocked}
            />
          </FormGroup>

          {!serverCtx && (
            <FormGroup fieldId="static-tls">
              <Checkbox
                id="static-tls"
                label={t("add_proxy.field_tls_short")}
                isChecked={tls}
                onChange={(_e, v) => setTls(v)}
                isDisabled={isLocked}
              />
              <SectionActions onDefaults={() => setTls(true)} isDisabled={isLocked} />
            </FormGroup>
          )}

          <FormGroup fieldId="static-compress">
            <Checkbox
              id="static-compress"
              label={t("add_proxy.field_compress_short")}
              isChecked={compress}
              onChange={(_e, v) => setCompress(v)}
              isDisabled={isLocked}
            />
          </FormGroup>
          <RequestBodyLimitField value={requestBodyMaxSize} onChange={setRequestBodyMaxSize} isDisabled={isLocked} idPrefix="add-static" />
        </Form>

        <div
          style={{
            border: "1px solid var(--pf-t--global--border--color--default)",
            borderRadius: "var(--pf-t--global--border--radius--small)",
            padding: "0 0.75rem",
            marginTop: "var(--pf-v6-global--spacer--md)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {!serverCtx && (
            <AccordionRow>
              <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} {...sectionAccordionProps("tls", expandedSection, setExpandedSection)} />
            </AccordionRow>
          )}
          <AccordionRow>
            <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} {...sectionAccordionProps("accessLog", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} {...sectionAccordionProps("errorHandlers", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} {...sectionAccordionProps("serverTimeouts", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <BasicAuthSection
              value={basicAuth}
              onChange={setBasicAuth}
              isDisabled={isLocked}
              {...sectionAccordionProps("basicAuth", expandedSection, setExpandedSection)}
            />
          </AccordionRow>
          <AccordionRow>
            <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isLocked} {...sectionAccordionProps("requestHeaders", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ResponseHeadersSection
              value={responseHeaders}
              onChange={v => setResponseHeaders(v ?? [])}
              isDisabled={isLocked}
              {...sectionAccordionProps("responseHeaders", expandedSection, setExpandedSection)}
            />
          </AccordionRow>
          <AccordionRow last>
            <RouteMatchersSection value={matchers} onChange={v => { setMatchers(v); if (!v?.path?.length) setHandlePath(false); }} isDisabled={isLocked} {...sectionAccordionProps("routeMatchers", expandedSection, setExpandedSection)} />
          </AccordionRow>
        </div>
        {matchers?.path?.length && !matchers.host?.length && !matchers.method?.length && !matchers.header && !matchers.query && !matchers.remote_ip && (
          <Checkbox
            id="add-static-handle-path"
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
                const resolvedAuth = await resolveBasicAuth(basicAuth);
                try {
                  await onAdd({
                    externalPort: serverCtx ? serverCtx.port : parseInt(port, 10),
                    externalScheme: undefined,
                    externalHost: undefined,
                    targetHost: "localhost",
                    targetPort: 0,
                    targetScheme: "http",
                    tls,
                    tlsSkipVerify: false,
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
                    disableHttp3: serverTimeouts.disableHttp3 || undefined,
                    requestBodyMaxSize: requestBodyMaxSize.trim() ? parseInt(requestBodyMaxSize, 10) : undefined,
                    tlsAdvanced: tlsValuesToAdvanced(tlsValues),
                    mtls: tlsValuesToMtls(tlsValues),
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
            <Button variant="primary" onClick={handleAdd}>{t("add_static.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
