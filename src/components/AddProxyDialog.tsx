import { useState, useEffect } from "react";
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
import { BasicAuthSection, resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { ForwardAuthSection, validateForwardAuth } from "./ForwardAuthSection";
import { UpstreamsSection, validateUpstreams, type ExtraUpstream } from "./UpstreamsSection";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsConfigToValues } from "./TlsSection";
import type { ErrorHandlerConfig, ForwardAuthConfig, LbPolicy } from "../api";
import { SectionActions } from "./SectionActions";

interface FormState {
  externalScheme: string;
  externalHost: string;
  externalPort: string;
  targetHost: string;
  targetPort: string;
  targetScheme: "http" | "https";
  tls: boolean;
  tlsSkipVerify: boolean;
  compress: boolean;
  label: string;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  onApiError?: (message: string) => void;
  initialValues?: Partial<FormState>;
  initialRewrite?: RewriteConfig;
  initialRequestHeaders?: HeaderOperation[];
  initialResponseHeaders?: HeaderOperation[];
  initialTransport?: TransportValues;
  initialBasicAuth?: AuthEntry[];
  initialExtraUpstreams?: ExtraUpstream[];
  initialLbPolicy?: LbPolicy;
  initialServerTimeouts?: ServerTimeoutValues;
  initialAccessLog?: AccessLogValues;
  initialErrorHandlers?: ErrorHandlerConfig[];
  initialForwardAuth?: ForwardAuthConfig;
  initialTlsValues?: TlsValues;
}

export function AddProxyDialog({ existingPorts, onAdd, onClose, onApiError, initialValues, initialRewrite, initialRequestHeaders, initialResponseHeaders, initialTransport, initialBasicAuth, initialExtraUpstreams, initialLbPolicy, initialServerTimeouts, initialAccessLog, initialErrorHandlers, initialForwardAuth, initialTlsValues }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();
  const [form, setForm] = useState<FormState>({
    externalScheme: "",
    externalHost: "",
    externalPort: "",
    targetHost: "localhost",
    targetPort: "",
    targetScheme: "http",
    tls: true,
    tlsSkipVerify: false,
    compress: false,
    label: "",
    ...initialValues,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [rewrite, setRewrite] = useState<RewriteConfig | undefined>(initialRewrite);
  const [requestHeaders, setRequestHeaders] = useState<HeaderOperation[] | undefined>(initialRequestHeaders);
  const [responseHeaders, setResponseHeaders] = useState<HeaderOperation[] | undefined>(initialResponseHeaders);
  const [transport, setTransport] = useState<TransportValues>(initialTransport ?? { dialTimeout: "", responseHeaderTimeout: "" });
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>(initialServerTimeouts ?? { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "" });
  const [accessLog, setAccessLog] = useState<AccessLogValues>(initialAccessLog ?? accessLogConfigToValues(undefined));
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(initialErrorHandlers ?? []);
  const [forwardAuth, setForwardAuth] = useState<ForwardAuthConfig | undefined>(initialForwardAuth);
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(initialBasicAuth ?? []);
  const [extraUpstreams, setExtraUpstreams] = useState<ExtraUpstream[]>(initialExtraUpstreams ?? []);
  const [lbPolicy, setLbPolicy] = useState<LbPolicy | "">(initialLbPolicy ?? "");
  const [tlsValues, setTlsValues] = useState<TlsValues>(initialTlsValues ?? tlsConfigToValues(undefined, undefined));
  const [extraSchemes, setExtraSchemes] = useState<string[]>([]);

  useEffect(() => {
    void readProxyConf().then(content => {
      const addresses = parseConfExternalAddresses(content);
      const schemes = Object.values(addresses)
        .map(a => a.scheme)
        .filter((s): s is string => !!s);
      setExtraSchemes([...new Set(schemes)]);
    }).catch(() => {});
  }, []);

  function validate(): FormErrors {
    const errs: FormErrors = {};
    const port = parseInt(form.externalPort, 10);
    if (!form.externalPort) errs.externalPort = t("add_proxy.validation_port_required");
    else if (isNaN(port)) errs.externalPort = t("add_proxy.validation_port_number");
    else if (port < 1 || port > 65535) errs.externalPort = t("add_proxy.validation_port_range");
    else if (existingPorts.includes(port)) errs.externalPort = t("add_proxy.validation_port_duplicate", { port });
    if (form.externalScheme && !form.externalHost.trim()) {
      errs.externalHost = t("add_proxy.validation_ext_host_required_with_scheme");
    }
    if (!form.targetHost.trim()) errs.targetHost = t("add_proxy.validation_target_host_required");
    const tport = parseInt(form.targetPort, 10);
    if (!form.targetPort) errs.targetPort = t("add_proxy.validation_target_port_required");
    else if (isNaN(tport) || tport < 1 || tport > 65535) errs.targetPort = t("add_proxy.validation_target_port_range");
    return errs;
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  const forwardAuthErr = validateForwardAuth(forwardAuth);

  function handleAddClick() {
    const errs = validate();
    const upstreamErr = validateUpstreams(extraUpstreams);
    if (Object.keys(errs).length > 0 || upstreamErr || forwardAuthErr) { setErrors(errs); return; }
    confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  const extHeader = form.externalScheme && form.externalHost
    ? `${form.externalScheme}://${form.externalHost}:${form.externalPort || "…"}`
    : form.externalHost
      ? `${form.externalHost}:${form.externalPort || "…"}`
      : form.externalPort
        ? `:${form.externalPort}`
        : null;
  const targetUrl = `${form.targetScheme}://${form.targetHost || "…"}:${form.targetPort || "…"}`;

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_proxy.aria_label")} variant="medium">
      <ModalHeader title={t("add_proxy.title")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("add_proxy.confirm_body", { port: form.externalPort, target: targetUrl })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        {extHeader && (
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
            <Label isCompact color={form.tls || form.externalScheme === "https" ? "blue" : "grey"}>{extHeader}</Label>
            <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>→</span>
            <Label isCompact color="grey">{targetUrl}</Label>
          </div>
        )}

        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="label">
            <TextInput
              id="label"
              value={form.label}
              onChange={(_e, v) => set("label", v)}
              placeholder={t("add_proxy.field_label_placeholder")}
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_external_address")} fieldId="external-port" isRequired>
            <ExternalAddressInput
              scheme={form.externalScheme}
              onSchemeChange={v => set("externalScheme", v)}
              host={form.externalHost}
              onHostChange={v => set("externalHost", v)}
              port={form.externalPort}
              onPortChange={v => set("externalPort", v)}
              suggestedSchemes={extraSchemes}
              isDisabled={isLocked}
              hostValidated={errors.externalHost ? "error" : "default"}
              portValidated={errors.externalPort ? "error" : "default"}
              portPlaceholder="8443"
              hostPlaceholder={t("add_proxy.ext_host_placeholder")}
              schemeNoneLabel={t("add_proxy.ext_scheme_none")}
              schemeCustomLabel={t("add_proxy.ext_scheme_custom")}
            />
            {(errors.externalPort || errors.externalHost) && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">{errors.externalHost ?? errors.externalPort}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
            {!errors.externalPort && !errors.externalHost && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>{t("add_proxy.field_external_address_help")}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_proxy.field_target_host")} fieldId="target-host" isRequired>
            <InputGroup>
              <div style={{ display: "flex", gap: 0, width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <Button
                    variant={form.targetScheme === "http" ? "primary" : "plain"}
                    size="sm"
                    onClick={() => set("targetScheme", "http")}
                    isDisabled={isLocked}
                  >http</Button>
                  <Button
                    variant={form.targetScheme === "https" ? "primary" : "plain"}
                    size="sm"
                    onClick={() => set("targetScheme", "https")}
                    isDisabled={isLocked}
                  >https</Button>
                </div>
                <TextInput
                  id="target-host"
                  value={form.targetHost}
                  onChange={(_e, v) => set("targetHost", v)}
                  placeholder={t("add_proxy.field_target_host_placeholder")}
                  isDisabled={isLocked}
                  validated={errors.targetHost ? "error" : "default"}
                  style={{ flex: 1 }}
                />
                <InputGroupText>:</InputGroupText>
                <TextInput
                  id="target-port"
                  type="number"
                  value={form.targetPort}
                  onChange={(_e, v) => set("targetPort", v)}
                  placeholder="8080"
                  isDisabled={isLocked}
                  validated={errors.targetPort ? "error" : "default"}
                  style={{ width: 90 }}
                />
              </div>
            </InputGroup>
            {(errors.targetHost || errors.targetPort) && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">{errors.targetHost ?? errors.targetPort}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
            {form.targetScheme === "https" && (
              <Checkbox
                id="tls-skip-verify"
                label={t("add_proxy.field_tls_skip_verify")}
                isChecked={form.tlsSkipVerify}
                onChange={(_e, checked) => set("tlsSkipVerify", checked)}
                isDisabled={isLocked}
                style={{ marginTop: "0.4rem" }}
              />
            )}
          </FormGroup>

          <FormGroup label={t("add_proxy.field_tls")} fieldId="tls">
            <Checkbox
              id="tls"
              label={t("add_proxy.field_tls_short")}
              isChecked={form.tls}
              onChange={(_e, checked) => set("tls", checked)}
              isDisabled={isLocked}
            />
            <SectionActions onDefaults={() => set("tls", true)} isDisabled={isLocked} />
          </FormGroup>

          <FormGroup label={t("add_proxy.field_compress")} fieldId="compress">
            <Checkbox
              id="compress"
              label={t("add_proxy.field_compress_short")}
              isChecked={form.compress}
              onChange={(_e, checked) => set("compress", checked)}
              isDisabled={isLocked}
            />
          </FormGroup>
        </Form>
        <TransportSection value={transport} onChange={setTransport} isDisabled={isLocked} />
        <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} />
        <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} />
        <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} />
        <ForwardAuthSection
          value={forwardAuth}
          onChange={setForwardAuth}
          isDisabled={isLocked}
          uriError={forwardAuthErr ?? undefined}
        />
        <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} />
        <BasicAuthSection value={basicAuth} onChange={setBasicAuth} isDisabled={isLocked} />
        <RewriteSection value={rewrite} onChange={setRewrite} isDisabled={isLocked} />
        <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isLocked} />
        <ResponseHeadersSection value={responseHeaders} onChange={setResponseHeaders} isDisabled={isLocked} />
        <UpstreamsSection
          value={extraUpstreams}
          lbPolicy={lbPolicy}
          onChange={(u, p) => { setExtraUpstreams(u); setLbPolicy(p); }}
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
              onClick={() => void confirmAction.submit(async () => {
                try {
                  await onAdd({
                    externalScheme: form.externalScheme || undefined,
                    externalHost: form.externalHost.trim() || undefined,
                    externalPort: parseInt(form.externalPort, 10),
                    targetHost: form.targetHost.trim(),
                    targetPort: parseInt(form.targetPort, 10),
                    targetScheme: form.targetScheme,
                    tls: form.tls,
                    tlsSkipVerify: form.targetScheme === "https" ? form.tlsSkipVerify : false,
                    compress: form.compress || undefined,
                    label: form.label.trim() || undefined,
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
                    forwardAuth: forwardAuth ?? undefined,
                    serverReadTimeout: serverTimeouts.readTimeout.trim() || undefined,
                    serverReadHeaderTimeout: serverTimeouts.readHeaderTimeout.trim() || undefined,
                    serverWriteTimeout: serverTimeouts.writeTimeout.trim() || undefined,
                    serverIdleTimeout: serverTimeouts.idleTimeout.trim() || undefined,
                    maxHeaderBytes: serverTimeouts.maxHeaderBytes.trim() ? parseInt(serverTimeouts.maxHeaderBytes, 10) : undefined,
                    tlsAdvanced: tlsValuesToAdvanced(tlsValues),
                    mtls: tlsValuesToMtls(tlsValues),
                  });
                } catch (e) {
                  if (e instanceof CaddyfileError) {
                    throw new Error(t("proxies.caddyfile_error_title") + ": " + e.message);
                  }
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_add_title"), e.message);
                    onApiError?.(e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_added", { port: form.externalPort }));
                onClose();
              })}
              isLoading={isSaving}
              isDisabled={isSaving}
            >{t("service.confirm_action")}</Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAddClick} isDisabled={!!forwardAuthErr}>{t("add_proxy.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
