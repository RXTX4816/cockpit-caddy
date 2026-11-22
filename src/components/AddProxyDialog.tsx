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
import { readProxyConf, parseConfExternalAddresses, CaddyApiError, CaddyfileError, routeHosts, hostsConflict, normalizeExternalHost, formatExternalAddressPreview, isPathOnlyMatcher } from "../api";
import type { ProxyEntry, RewriteConfig, HeaderOperation, RouteMatch, ServerDef } from "../api";
import { TlsModeField, defaultTlsMode, hasPublicName, tlsModeToEntry, type TlsMode } from "./TlsModeField";
import { RouteMatchersSection } from "./RouteMatchersSection";
import { SnippetImportsField } from "./SnippetImportsField";
import { parseListenPort } from "./AddServerDialog";
import { EXTERNAL_ADDRESS_BUILTIN_SCHEMES } from "./externalAddressSchemes";
import { externalHostFieldError } from "./externalHostField";
import { isValidPort } from "@rxtx4816/cockpit-plugin-base-react/lib/uri";
import { RewriteSection } from "./RewriteSection";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { TransportSection, type TransportValues } from "./TransportSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { RequestBodyLimitField } from "./RequestBodyLimitField";
import { AccessLogSection, type AccessLogValues, accessLogValuesToConfig, accessLogConfigToValues } from "./AccessLogSection";
import { BasicAuthSection, resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { ForwardAuthSection, validateForwardAuth } from "./ForwardAuthSection";
import { UpstreamsSection, type ExtraUpstream } from "./UpstreamsSection";
import { LbRetrySection, lbRetryValuesToConfig, lbRetryConfigToValues, type LbRetryValues } from "./LbRetrySection";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsValuesToCustomTls, tlsConfigToValues } from "./TlsSection";
import type { ErrorHandlerConfig, ForwardAuthConfig, LbPolicy } from "../api";
import { ProxyDialogTabs, InlineAddressField, TargetField, NamedRouteField, firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabFlags, type ProxyTabValues } from "./proxyTabFlags";
import type { ServerContext } from "./AddRedirectDialog";
import {
  FormSelect,
  FormSelectOption,
} from "@patternfly/react-core";

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
  /**
   * Other standalone proxies to check the new port against. A conflict is only raised
   * when ports match *and* hosts collide (#139) — two proxies on the same port with
   * distinct, non-overlapping hosts coexist fine in Caddy (ordinary Host/SNI-based
   * virtual hosting), the same way multiple site blocks in a plain Caddyfile share a
   * port by subdomain.
   */
  existingRoutes: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  onApiError?: (message: string) => void;
  initialValues?: Partial<FormState>;
  /** Duplicate (#246): the source's certificate mode, instead of following the host field. */
  initialTlsMode?: TlsMode;
  initialTlsOnDemand?: boolean;
  initialRewrite?: RewriteConfig;
  initialRequestHeaders?: HeaderOperation[];
  initialResponseHeaders?: HeaderOperation[];
  initialTransport?: TransportValues;
  initialBasicAuth?: AuthEntry[];
  initialExtraUpstreams?: ExtraUpstream[];
  initialLbPolicy?: LbPolicy;
  initialLbRetry?: LbRetryValues;
  initialServerTimeouts?: ServerTimeoutValues;
  initialRequestBodyMaxSize?: string;
  initialAccessLog?: AccessLogValues;
  initialErrorHandlers?: ErrorHandlerConfig[];
  initialForwardAuth?: ForwardAuthConfig;
  initialTlsValues?: TlsValues;
  initialMatchers?: RouteMatch;
  initialImports?: string[];
  initialHandlePath?: boolean;
  initialIsNamedRoute?: boolean;
  initialNamedRouteName?: string;
  servers?: ServerDef[];
  initialServerKey?: string;
}

const noop = () => {};

export function AddProxyDialog({ existingRoutes, onAdd, onClose, onApiError, initialValues, initialTlsMode, initialTlsOnDemand, initialRewrite, initialRequestHeaders, initialResponseHeaders, initialTransport, initialBasicAuth, initialExtraUpstreams, initialLbPolicy, initialLbRetry, initialServerTimeouts, initialRequestBodyMaxSize, initialAccessLog, initialErrorHandlers, initialForwardAuth, initialTlsValues, initialMatchers, initialImports, initialHandlePath, initialIsNamedRoute, initialNamedRouteName, servers, initialServerKey }: Props) {
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
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>(initialServerTimeouts ?? { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false });
  const [requestBodyMaxSize, setRequestBodyMaxSize] = useState(initialRequestBodyMaxSize ?? "");
  const [accessLog, setAccessLog] = useState<AccessLogValues>(initialAccessLog ?? accessLogConfigToValues(undefined));
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(initialErrorHandlers ?? []);
  const [forwardAuth, setForwardAuth] = useState<ForwardAuthConfig | undefined>(initialForwardAuth);
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(initialBasicAuth ?? []);
  const [extraUpstreams, setExtraUpstreams] = useState<ExtraUpstream[]>(initialExtraUpstreams ?? []);
  const [lbPolicy, setLbPolicy] = useState<LbPolicy | "">(initialLbPolicy ?? "");
  const [lbRetry, setLbRetry] = useState<LbRetryValues>(initialLbRetry ?? lbRetryConfigToValues(undefined));
  const [tlsValues, setTlsValues] = useState<TlsValues>(initialTlsValues ?? tlsConfigToValues(undefined, undefined));
  const [activeTab, setActiveTab] = useState<ProxyTabKey>("general");
  const [matchers, setMatchers] = useState<RouteMatch | undefined>(initialMatchers);
  const [imports, setImports] = useState<string[] | undefined>(initialImports);
  const [handlePath, setHandlePath] = useState(initialHandlePath ?? false);
  const [isNamedRoute, setIsNamedRoute] = useState(initialIsNamedRoute ?? false);
  const [namedRouteName, setNamedRouteName] = useState(initialNamedRouteName ?? "");
  const [selectedServerKey, setSelectedServerKey] = useState(initialServerKey ?? "");
  const [extraSchemes, setExtraSchemes] = useState<string[]>([]);
  // #246: null follows the host field (ACME for a public name), until the user picks a mode.
  const [tlsModeChoice, setTlsModeChoice] = useState<TlsMode | null>(initialTlsMode ?? (form.tls ? null : "off"));
  const publicName = hasPublicName(form.externalHost);
  const chosenMode = tlsModeChoice ?? defaultTlsMode(form.externalHost);
  const tlsMode: TlsMode = chosenMode === "acme" && !publicName ? "internal" : chosenMode;
  const [tlsOnDemand, setTlsOnDemand] = useState(initialTlsOnDemand ?? false);

  const selectedServer = servers?.find(s => s.key === selectedServerKey);
  const serverCtx: ServerContext | undefined = selectedServer ? {
    serverKey: selectedServer.key,
    serverName: selectedServer.name,
    port: parseListenPort(selectedServer.listenAddresses[0] ?? ":443"),
  } : undefined;

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
    if (!serverCtx) {
      const port = parseInt(form.externalPort, 10);
      if (!form.externalPort) errs.externalPort = t("add_proxy.validation_port_required");
      else if (isNaN(port)) errs.externalPort = t("add_proxy.validation_port_number");
      else if (!isValidPort(port)) errs.externalPort = t("add_proxy.validation_port_range");
      else if (existingRoutes.some(r =>
        r.externalPort === port &&
        hostsConflict(routeHosts(r), routeHosts({ externalHost: normalizeExternalHost(form.externalHost), matchers }))
      )) errs.externalPort = t("add_proxy.validation_port_duplicate", { port });
      const hostErr = externalHostFieldError(form.externalHost, t);
      if (hostErr) errs.externalHost = hostErr;
    }
    if (!errs.externalHost && form.externalScheme && !form.externalHost.trim()) {
      errs.externalHost = t("add_proxy.validation_ext_host_required_with_scheme");
    }
    // "https://" in the address triggers Caddy's automatic HTTPS on its own, regardless
    // of the TLS toggle below — letting this combination through would silently create
    // TLS behavior this app doesn't know about and isn't tracking.
    if (form.externalScheme === "https" && tlsMode === "off") {
      errs.externalScheme = t("add_proxy.validation_https_requires_tls");
    }
    if (!form.targetHost.trim()) errs.targetHost = t("add_proxy.validation_target_host_required");
    const tport = parseInt(form.targetPort, 10);
    if (!form.targetPort) errs.targetPort = t("add_proxy.validation_target_port_required");
    else if (isNaN(tport) || !isValidPort(tport)) errs.targetPort = t("add_proxy.validation_target_port_range");
    return errs;
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  const forwardAuthErr = validateForwardAuth(forwardAuth);

  const tabValues: ProxyTabValues = {
    basicAuth, forwardAuth, forwardAuthError: forwardAuthErr, tlsValues, matchers, rewrite, requestHeaders, responseHeaders,
    isNamedRoute, extraUpstreams, lbPolicy, lbRetry, transport, accessLog, errorHandlers, serverTimeouts, requestBodyMaxSize,
  };
  const flags = proxyTabFlags(tabValues, Object.values(errors).some(Boolean));

  function handleAddClick() {
    const errs = validate();
    const after = proxyTabFlags(tabValues, Object.keys(errs).length > 0);
    const errorTab = firstTabWithError(after.hasError);
    if (errorTab) {
      setErrors(errs);
      setActiveTab(errorTab);
      return;
    }
    confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  const extHeader = formatExternalAddressPreview(form.externalScheme, form.externalHost, form.externalPort);
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
            <Label isCompact color={tlsMode !== "off" || form.externalScheme === "https" ? "blue" : "grey"}>{extHeader}</Label>
            <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>→</span>
            <Label isCompact color="grey">{targetUrl}</Label>
          </div>
        )}

        <ProxyDialogTabs
          active={activeTab}
          onSelect={setActiveTab}
          tabs={[
            {
              key: "general",
              hasError: flags.hasError.general,
              content: (
                <Form isHorizontal>
                  <FormGroup label={t("add_proxy.field_label")} fieldId="label">
                    <TextInput id="label" value={form.label} onChange={(_e, v) => set("label", v)} isDisabled={isLocked} />
                    <FormHelperText><HelperText><HelperTextItem>{t("add_proxy.field_label_help")}</HelperTextItem></HelperText></FormHelperText>
                  </FormGroup>

                  {servers && servers.length > 0 && (
                    <FormGroup label={t("servers.selector_label")} fieldId="proxy-server">
                      <FormSelect
                        id="proxy-server"
                        value={selectedServerKey}
                        onChange={(_e, v) => { setSelectedServerKey(v); setErrors(prev => ({ ...prev, externalPort: undefined })); }}
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
                    <FormGroup label={t("add_proxy.field_external_address")} fieldId="external-port">
                      <Label isCompact color="blue">{serverCtx.serverName} (:{serverCtx.port})</Label>
                    </FormGroup>
                  ) : (
                    <FormGroup label={t("add_proxy.field_external_address")} fieldId="external-port" isRequired>
                      <InlineAddressField
                        scheme={form.externalScheme}
                        onSchemeChange={v => set("externalScheme", v)}
                        host={form.externalHost}
                        onHostChange={v => set("externalHost", v)}
                        port={form.externalPort}
                        onPortChange={v => set("externalPort", v)}
                        builtinSchemes={EXTERNAL_ADDRESS_BUILTIN_SCHEMES}
                        suggestedSchemes={extraSchemes}
                        isDisabled={isLocked}
                        hostError={!!(errors.externalHost || errors.externalScheme)}
                        portError={!!errors.externalPort}
                      />
                      <FormHelperText>
                        <HelperText>
                          {errors.externalHost || errors.externalScheme || errors.externalPort ? (
                            <>
                              {(errors.externalHost ?? errors.externalScheme) && <HelperTextItem variant="error">{errors.externalHost ?? errors.externalScheme}</HelperTextItem>}
                              {errors.externalPort && <HelperTextItem variant="error">{errors.externalPort}</HelperTextItem>}
                            </>
                          ) : (
                            <HelperTextItem>{t("add_proxy.field_external_address_help")}</HelperTextItem>
                          )}
                        </HelperText>
                      </FormHelperText>
                    </FormGroup>
                  )}

                  <TargetField
                    idPrefix=""
                    scheme={form.targetScheme}
                    onSchemeChange={v => set("targetScheme", v)}
                    host={form.targetHost}
                    onHostChange={v => set("targetHost", v)}
                    port={form.targetPort}
                    onPortChange={v => set("targetPort", v)}
                    skipVerify={form.tlsSkipVerify}
                    onSkipVerifyChange={v => set("tlsSkipVerify", v)}
                    hostError={errors.targetHost}
                    portError={errors.targetPort}
                    isDisabled={isLocked}
                  />

                  {!serverCtx && (
                    <TlsModeField id="tls" value={tlsMode} onChange={setTlsModeChoice} publicName={publicName} isDisabled={isLocked} onDemand={tlsOnDemand} onOnDemandChange={setTlsOnDemand} />
                  )}

                  <FormGroup label={t("add_proxy.field_compress")} fieldId="compress">
                    <Checkbox
                      id="compress"
                      label={t("add_proxy.field_compress_short")}
                      isChecked={form.compress}
                      onChange={(_e, checked) => set("compress", checked)}
                      isDisabled={isLocked}
                    />
                  </FormGroup>
                  <SnippetImportsField value={imports} onChange={setImports} isDisabled={isLocked} />
                </Form>
              ),
            },
            {
              key: "security",
              configured: flags.configured.security,
              hasError: flags.hasError.security,
              content: (
                <>
                  <BasicAuthSection value={basicAuth} onChange={setBasicAuth} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <ForwardAuthSection value={forwardAuth} onChange={setForwardAuth} isDisabled={isLocked} uriError={forwardAuthErr ?? undefined} isExpanded onToggleExpanded={noop} />
                  {!serverCtx && (
                    <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} hostless={!form.externalHost.trim()} isExpanded onToggleExpanded={noop} />
                  )}
                </>
              ),
            },
            {
              key: "routing",
              configured: flags.configured.routing,
              content: (
                <>
                  <RouteMatchersSection value={matchers} onChange={v => { setMatchers(v); if (!isPathOnlyMatcher(v)) setHandlePath(false); }} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  {isPathOnlyMatcher(matchers) && (
                    <Checkbox
                      id="add-proxy-handle-path"
                      label={t("handle_path.label")}
                      isChecked={handlePath}
                      onChange={(_e, v) => setHandlePath(v)}
                      isDisabled={isLocked}
                    />
                  )}
                  <RewriteSection value={rewrite} onChange={setRewrite} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <ResponseHeadersSection value={responseHeaders} onChange={setResponseHeaders} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <NamedRouteField idPrefix="add-proxy-" enabled={isNamedRoute} onEnabledChange={setIsNamedRoute} name={namedRouteName} onNameChange={setNamedRouteName} isDisabled={isLocked} />
                </>
              ),
            },
            {
              key: "upstreams",
              configured: flags.configured.upstreams,
              hasError: flags.hasError.upstreams,
              content: (
                <>
                  <UpstreamsSection
                    value={extraUpstreams}
                    lbPolicy={lbPolicy}
                    onChange={(u, p) => { setExtraUpstreams(u); setLbPolicy(p); }}
                    isDisabled={isLocked}
                    isExpanded
                    onToggleExpanded={noop}
                  />
                  <LbRetrySection value={lbRetry} onChange={setLbRetry} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <TransportSection value={transport} onChange={setTransport} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                </>
              ),
            },
            {
              key: "logging",
              configured: flags.configured.logging,
              content: (
                <>
                  <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} isExpanded onToggleExpanded={noop} />
                  <RequestBodyLimitField value={requestBodyMaxSize} onChange={setRequestBodyMaxSize} isDisabled={isLocked} idPrefix="add-proxy" />
                </>
              ),
            },
          ]}
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
                    externalScheme: serverCtx ? undefined : (form.externalScheme || undefined),
                    externalHost: serverCtx ? undefined : normalizeExternalHost(form.externalHost),
                    externalPort: serverCtx ? serverCtx.port : parseInt(form.externalPort, 10),
                    targetHost: form.targetHost.trim(),
                    targetPort: parseInt(form.targetPort, 10),
                    targetScheme: form.targetScheme,
                    ...(serverCtx ? { tls: form.tls } : tlsModeToEntry(tlsMode, form.externalHost)),
                    tlsOnDemand: tlsMode !== "off" && tlsOnDemand ? true : undefined,
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
                    lbRetry: lbRetryValuesToConfig(lbRetry),
                    accessLog: accessLogValuesToConfig(accessLog),
                    errorHandlers: errorHandlers.length ? errorHandlers : undefined,
                    forwardAuth: forwardAuth ?? undefined,
                    serverReadTimeout: serverTimeouts.readTimeout.trim() || undefined,
                    serverReadHeaderTimeout: serverTimeouts.readHeaderTimeout.trim() || undefined,
                    serverWriteTimeout: serverTimeouts.writeTimeout.trim() || undefined,
                    serverIdleTimeout: serverTimeouts.idleTimeout.trim() || undefined,
                    maxHeaderBytes: serverTimeouts.maxHeaderBytes.trim() ? parseInt(serverTimeouts.maxHeaderBytes, 10) : undefined,
                    disableHttp3: serverTimeouts.disableHttp3 || undefined,
                    requestBodyMaxSize: requestBodyMaxSize.trim() ? parseInt(requestBodyMaxSize, 10) : undefined,
                    tlsAdvanced: tlsValuesToAdvanced(tlsValues),
                    mtls: tlsValuesToMtls(tlsValues),
                    customTls: tlsValuesToCustomTls(tlsValues),
                    matchers: matchers ?? undefined,
                    imports,
                    handlePath: handlePath || undefined,
                    isNamedRoute: isNamedRoute || undefined,
                    namedRouteName: (isNamedRoute && namedRouteName.trim()) ? namedRouteName.trim() : undefined,
                    namedServerKey: serverCtx?.serverKey,
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
                toast.success(t("toast.proxy_added", { port: serverCtx ? serverCtx.port : form.externalPort }));
                onClose();
              })}
              isLoading={isSaving}
              isDisabled={isSaving}
            >{t("service.confirm_action")}</Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAddClick}>{t("add_proxy.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
