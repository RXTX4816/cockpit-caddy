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
import { useToast, ExternalAddressInput } from "@rxtx4816/cockpit-plugin-base-react/components";
import { readProxyConf, parseConfExternalAddresses, CaddyApiError, CaddyfileError } from "../api";
import type { ProxyEntry, RewriteConfig, HeaderOperation } from "../api";
import { RewriteSection } from "./RewriteSection";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { TransportSection, type TransportValues } from "./TransportSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { AccessLogSection, type AccessLogValues, accessLogValuesToConfig, accessLogConfigToValues } from "./AccessLogSection";
import { BasicAuthSection, type AuthEntry } from "./BasicAuthSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { UpstreamsSection, validateUpstreams, type ExtraUpstream } from "./UpstreamsSection";
import { hashPassword } from "../api";
import type { ErrorHandlerConfig, LbPolicy } from "../api";

async function resolveBasicAuth(entries: AuthEntry[]): Promise<{ username: string; passwordHash: string }[]> {
  return Promise.all(
    entries
      .filter(e => e.username.trim())
      .map(async e => {
        const hash = e.password.trim()
          ? await hashPassword(e.password.trim())
          : (e.existingHash ?? "");
        return { username: e.username.trim(), passwordHash: hash };
      }),
  );
}

interface Props {
  proxy: ProxyEntry;
  existingPorts: number[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
  onApiError?: (message: string) => void;
}

export function EditProxyDialog({ proxy, existingPorts, onSave, onClose, onApiError }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const saveConfirm = useConfirmAction();
  const [externalScheme, setExternalScheme] = useState(proxy.externalScheme ?? "");
  const [externalHost, setExternalHost] = useState(proxy.externalHost ?? "");
  const [externalPort, setExternalPort] = useState(String(proxy.externalPort));
  const [targetScheme, setTargetScheme] = useState<"http" | "https">(proxy.targetScheme);
  const [targetHost, setTargetHost] = useState(proxy.targetHost);
  const [targetPort, setTargetPort] = useState(String(proxy.targetPort));
  const [tls, setTls] = useState(proxy.tls);
  const [tlsSkipVerify, setTlsSkipVerify] = useState(proxy.tlsSkipVerify);
  const [compress, setCompress] = useState(proxy.compress ?? false);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [rewrite, setRewrite] = useState<RewriteConfig | undefined>(proxy.rewrite);
  const [requestHeaders, setRequestHeaders] = useState<HeaderOperation[] | undefined>(proxy.requestHeaders);
  const [responseHeaders, setResponseHeaders] = useState<HeaderOperation[] | undefined>(proxy.responseHeaders);
  const [transport, setTransport] = useState<TransportValues>({
    dialTimeout: proxy.dialTimeout ?? "",
    responseHeaderTimeout: proxy.responseHeaderTimeout ?? "",
  });
  const [accessLog, setAccessLog] = useState<AccessLogValues>(accessLogConfigToValues(proxy.accessLog));
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>({
    readTimeout: proxy.serverReadTimeout ?? "",
    readHeaderTimeout: proxy.serverReadHeaderTimeout ?? "",
    writeTimeout: proxy.serverWriteTimeout ?? "",
    idleTimeout: proxy.serverIdleTimeout ?? "",
    maxHeaderBytes: proxy.maxHeaderBytes != null ? String(proxy.maxHeaderBytes) : "",
  });
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(
    (proxy.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash }))
  );
  const [extraUpstreams, setExtraUpstreams] = useState<ExtraUpstream[]>(
    (proxy.extraUpstreams ?? []).map(u => ({ host: u.host, port: String(u.port) }))
  );
  const [lbPolicy, setLbPolicy] = useState<LbPolicy | "">(proxy.lbPolicy ?? "");
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(proxy.errorHandlers ?? []);
  const [extraSchemes, setExtraSchemes] = useState<string[]>([]);
  const [extHostErr, setExtHostErr] = useState<string | null>(null);

  useEffect(() => {
    void readProxyConf().then(content => {
      const addresses = parseConfExternalAddresses(content);
      const schemes = Object.values(addresses)
        .map(a => a.scheme)
        .filter((s): s is string => !!s);
      setExtraSchemes([...new Set(schemes)]);
    }).catch(() => {});
  }, []);

  function portError(): string | null {
    const n = parseInt(externalPort, 10);
    if (!externalPort || isNaN(n)) return t("add_proxy.validation_port_number");
    if (n < 1 || n > 65535) return t("add_proxy.validation_port_range");
    if (existingPorts.includes(n)) return t("add_proxy.validation_port_duplicate", { port: n });
    return null;
  }

  function validateAndConfirm() {
    if (externalScheme && !externalHost.trim()) {
      setExtHostErr(t("add_proxy.validation_ext_host_required_with_scheme"));
      return;
    }
    if (validateUpstreams(extraUpstreams)) return;
    setExtHostErr(null);
    saveConfirm.confirm();
  }

  const portErr = portError();
  const isConfirming = saveConfirm.step !== "idle";
  const isBusy = saveConfirm.step === "submitting";

  const warningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isConfirming) warningRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [isConfirming]);

  const extHeader = externalScheme && externalHost
    ? `${externalScheme}://${externalHost}:${externalPort || "…"}`
    : externalHost
      ? `${externalHost}:${externalPort || "…"}`
      : `:${externalPort || "…"}`;
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
          <Label isCompact color={tls || externalScheme === "https" ? "blue" : "grey"}>{extHeader}</Label>
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

          <FormGroup label={t("add_proxy.field_external_address")} fieldId="edit-external-port" isRequired>
            <ExternalAddressInput
              scheme={externalScheme}
              onSchemeChange={v => { setExternalScheme(v); setExtHostErr(null); }}
              host={externalHost}
              onHostChange={v => { setExternalHost(v); setExtHostErr(null); }}
              port={externalPort}
              onPortChange={setExternalPort}
              suggestedSchemes={extraSchemes}
              isDisabled={isConfirming}
              hostValidated={extHostErr ? "error" : "default"}
              portValidated={portErr ? "error" : "default"}
              portPlaceholder="8443"
              hostPlaceholder={t("add_proxy.ext_host_placeholder")}
              schemeNoneLabel={t("add_proxy.ext_scheme_none")}
              schemeCustomLabel={t("add_proxy.ext_scheme_custom")}
            />
            {(portErr || extHostErr) && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{extHostErr ?? portErr}</HelperTextItem></HelperText>
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

          <FormGroup label={t("add_proxy.field_compress")} fieldId="edit-compress">
            <Checkbox
              id="edit-compress"
              label={t("add_proxy.field_compress_short")}
              isChecked={compress}
              onChange={(_e, checked) => setCompress(checked)}
              isDisabled={isConfirming}
            />
          </FormGroup>
        </Form>
        <TransportSection value={transport} onChange={setTransport} isDisabled={isConfirming} />
        <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isConfirming} />
        <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isConfirming} />
        <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isConfirming} />
        <BasicAuthSection value={basicAuth} onChange={setBasicAuth} isDisabled={isConfirming} />
        <RewriteSection value={rewrite} onChange={setRewrite} isDisabled={isConfirming} />
        <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isConfirming} />
        <ResponseHeadersSection value={responseHeaders} onChange={setResponseHeaders} isDisabled={isConfirming} />
        <UpstreamsSection
          value={extraUpstreams}
          lbPolicy={lbPolicy}
          onChange={(u, p) => { setExtraUpstreams(u); setLbPolicy(p); }}
          isDisabled={isConfirming}
        />

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
                const entry: ProxyEntry = {
                  ...proxy,
                  externalScheme: externalScheme || undefined,
                  externalHost: externalHost.trim() || undefined,
                  externalPort: port,
                  id: String(port),
                  targetScheme,
                  targetHost: targetHost.trim(),
                  targetPort: parseInt(targetPort, 10),
                  tls,
                  tlsSkipVerify: targetScheme === "https" ? tlsSkipVerify : false,
                  compress: compress || undefined,
                  label: label.trim() || undefined,
                  dialTimeout: transport.dialTimeout.trim() || undefined,
                  responseHeaderTimeout: transport.responseHeaderTimeout.trim() || undefined,
                  basicAuth: basicAuth.length ? await resolveBasicAuth(basicAuth) : undefined,
                  rewrite: rewrite ?? undefined,
                  requestHeaders: requestHeaders ?? undefined,
                  responseHeaders: responseHeaders ?? undefined,
                  extraUpstreams: extraUpstreams.length
                    ? extraUpstreams.map(u => ({ host: u.host.trim(), port: parseInt(u.port, 10) }))
                    : undefined,
                  lbPolicy: (lbPolicy || undefined) as LbPolicy | undefined,
                  accessLog: accessLogValuesToConfig(accessLog),
                  errorHandlers: errorHandlers.length ? errorHandlers : undefined,
                  serverReadTimeout: serverTimeouts.readTimeout.trim() || undefined,
                  serverReadHeaderTimeout: serverTimeouts.readHeaderTimeout.trim() || undefined,
                  serverWriteTimeout: serverTimeouts.writeTimeout.trim() || undefined,
                  serverIdleTimeout: serverTimeouts.idleTimeout.trim() || undefined,
                  maxHeaderBytes: serverTimeouts.maxHeaderBytes.trim() ? parseInt(serverTimeouts.maxHeaderBytes, 10) : undefined,
                };
                try {
                  await onSave(entry);
                } catch (e) {
                  if (e instanceof CaddyfileError) {
                    // Keep dialog open; error is shown via saveConfirm.error
                    throw new Error(t("proxies.caddyfile_error_title") + ": " + e.message);
                  }
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_edit_title"), e.message);
                    onApiError?.(e.message);
                    return;
                  }
                  throw e;
                }
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
            <Button variant="primary" onClick={validateAndConfirm} isDisabled={!!portErr}>
              {t("edit_proxy.save_button")}
            </Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
