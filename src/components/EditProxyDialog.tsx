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
import { TlsModeField, hasPublicName, tlsModeOf, tlsModeToEntry, type TlsMode } from "./TlsModeField";
import { EXTERNAL_ADDRESS_BUILTIN_SCHEMES } from "./externalAddressSchemes";
import { externalHostFieldError } from "./externalHostField";
import { isValidPort } from "@rxtx4816/cockpit-plugin-base-react/lib/uri";
import type { ProxyEntry, RewriteConfig, HeaderOperation, RouteMatch, ServerDef } from "../api";
import { RouteMatchersSection } from "./RouteMatchersSection";
import { SnippetImportsField } from "./SnippetImportsField";
import { RewriteSection } from "./RewriteSection";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { TransportSection, type TransportValues } from "./TransportSection";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsValuesToCustomTls, tlsConfigToValues } from "./TlsSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { RequestBodyLimitField } from "./RequestBodyLimitField";
import { AccessLogSection, type AccessLogValues, accessLogValuesToConfig, accessLogConfigToValues } from "./AccessLogSection";
import { BasicAuthSection, resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { ForwardAuthSection, validateForwardAuth } from "./ForwardAuthSection";
import { UpstreamsSection, type ExtraUpstream } from "./UpstreamsSection";
import { LbRetrySection, lbRetryValuesToConfig, lbRetryConfigToValues, type LbRetryValues } from "./LbRetrySection";
import type { ErrorHandlerConfig, ForwardAuthConfig, LbPolicy } from "../api";
import { ProxyDialogTabs, InlineAddressField, TargetField, NamedRouteField, firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabFlags, type ProxyTabValues } from "./proxyTabFlags";

interface Props {
  proxy: ProxyEntry;
  /** See AddProxyDialog's existingRoutes: a conflict requires both a port and a host match (#139). */
  existingRoutes: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
  onApiError?: (message: string) => void;
  servers?: ServerDef[];
}

const noop = () => {};

export function EditProxyDialog({ proxy, existingRoutes, onSave, onClose, onApiError, servers }: Props) {
  const namedServer = proxy.namedServerKey ? servers?.find(s => s.key === proxy.namedServerKey) : undefined;
  const { t } = useTranslation();
  const toast = useToast();
  const saveConfirm = useConfirmAction();
  const [externalScheme, setExternalScheme] = useState(proxy.externalScheme ?? "");
  const [externalHost, setExternalHost] = useState(proxy.externalHost ?? "");
  const [externalPort, setExternalPort] = useState(String(proxy.externalPort));
  const [targetScheme, setTargetScheme] = useState<"http" | "https">(proxy.targetScheme);
  const [targetHost, setTargetHost] = useState(proxy.targetHost);
  const [targetPort, setTargetPort] = useState(String(proxy.targetPort));
  // #246: keep the site's issuer; a hand-written ACME site must not turn into `tls internal`.
  const [tlsModeChoice, setTlsModeChoice] = useState<TlsMode>(tlsModeOf(proxy));
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
    disableHttp3: proxy.disableHttp3 ?? false,
  });
  const [requestBodyMaxSize, setRequestBodyMaxSize] = useState(proxy.requestBodyMaxSize != null ? String(proxy.requestBodyMaxSize) : "");
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(
    (proxy.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash }))
  );
  const [extraUpstreams, setExtraUpstreams] = useState<ExtraUpstream[]>(
    (proxy.extraUpstreams ?? []).map(u => ({ host: u.host, port: String(u.port) }))
  );
  const [lbPolicy, setLbPolicy] = useState<LbPolicy | "">(proxy.lbPolicy ?? "");
  const [lbRetry, setLbRetry] = useState<LbRetryValues>(lbRetryConfigToValues(proxy.lbRetry));
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(proxy.errorHandlers ?? []);
  const [forwardAuth, setForwardAuth] = useState<ForwardAuthConfig | undefined>(proxy.forwardAuth);
  const [tlsValues, setTlsValues] = useState<TlsValues>(tlsConfigToValues(proxy.tlsAdvanced, proxy.mtls, proxy.customTls));
  const [activeTab, setActiveTab] = useState<ProxyTabKey>("general");
  const [matchers, setMatchers] = useState<RouteMatch | undefined>(proxy.matchers);
  const [imports, setImports] = useState<string[] | undefined>(proxy.imports);
  const [handlePath, setHandlePath] = useState(proxy.handlePath ?? false);
  const [isNamedRoute, setIsNamedRoute] = useState(proxy.isNamedRoute ?? false);
  const [namedRouteName, setNamedRouteName] = useState(proxy.namedRouteName ?? "");
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

  const publicName = hasPublicName(externalHost);
  const tlsMode: TlsMode = tlsModeChoice === "acme" && !publicName ? "internal" : tlsModeChoice;
  const [tlsOnDemand, setTlsOnDemand] = useState(!!proxy.tlsOnDemand);
  const tls = tlsMode !== "off";

  function portError(): string | null {
    const n = parseInt(externalPort, 10);
    if (!externalPort || isNaN(n)) return t("add_proxy.validation_port_number");
    if (!isValidPort(n)) return t("add_proxy.validation_port_range");
    if (existingRoutes.some(r =>
      r.externalPort === n &&
      hostsConflict(routeHosts(r), routeHosts({ externalHost: normalizeExternalHost(externalHost), matchers }))
    )) return t("add_proxy.validation_port_duplicate", { port: n });
    return null;
  }

  const forwardAuthErr = validateForwardAuth(forwardAuth);

  function generalError(): string | null {
    const hostErr = externalHostFieldError(externalHost, t);
    if (hostErr) return hostErr;
    if (externalScheme && !externalHost.trim()) return t("add_proxy.validation_ext_host_required_with_scheme");
    // "https://" in the address triggers Caddy's automatic HTTPS on its own, regardless
    // of the TLS toggle below — letting this combination through would silently create
    // TLS behavior this app doesn't know about and isn't tracking.
    if (externalScheme === "https" && !tls) return t("add_proxy.validation_https_requires_tls");
    return null;
  }

  const targetHostErr = targetHost.trim() ? null : t("add_proxy.validation_target_host_required");
  const targetPortErr = (() => {
    const n = parseInt(targetPort, 10);
    if (!targetPort) return t("add_proxy.validation_target_port_required");
    return isNaN(n) || !isValidPort(n) ? t("add_proxy.validation_target_port_range") : null;
  })();

  function validateAndConfirm() {
    const hostErr = proxy.namedServerKey ? null : generalError();
    setExtHostErr(hostErr);
    const after = proxyTabFlags(tabValues, !!hostErr || !!portErr || !!targetHostErr || !!targetPortErr);
    const errorTab = firstTabWithError(after.hasError);
    if (errorTab) {
      setActiveTab(errorTab);
      return;
    }
    saveConfirm.confirm();
  }

  const portErr = proxy.namedServerKey ? null : portError();
  const tabValues: ProxyTabValues = {
    basicAuth, forwardAuth, forwardAuthError: forwardAuthErr, tlsValues, matchers, rewrite, requestHeaders, responseHeaders,
    isNamedRoute, extraUpstreams, lbPolicy, lbRetry, transport, accessLog, errorHandlers, serverTimeouts, requestBodyMaxSize,
  };
  const flags = proxyTabFlags(tabValues, !!extHostErr || !!portErr || !!targetHostErr || !!targetPortErr);
  const isConfirming = saveConfirm.step !== "idle";
  const isBusy = saveConfirm.step === "submitting";

  const warningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isConfirming) warningRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [isConfirming]);

  const extHeader = formatExternalAddressPreview(externalScheme, externalHost, externalPort) ?? ":…";
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

        <ProxyDialogTabs
          active={activeTab}
          onSelect={setActiveTab}
          tabs={[
            {
              key: "general",
              hasError: flags.hasError.general,
              content: (
                <Form isHorizontal>
                  <FormGroup label={t("add_proxy.field_label")} fieldId="edit-label">
                    <TextInput id="edit-label" value={label} onChange={(_e, v) => setLabel(v)} isDisabled={isConfirming} />
                    <FormHelperText><HelperText><HelperTextItem>{t("add_proxy.field_label_help")}</HelperTextItem></HelperText></FormHelperText>
                  </FormGroup>

                  {proxy.namedServerKey ? (
                    <FormGroup label={t("add_proxy.field_external_address")} fieldId="edit-external-port">
                      <Label isCompact color="blue">
                        {namedServer ? `${namedServer.name} (:${proxy.externalPort})` : `:${proxy.externalPort}`}
                      </Label>
                    </FormGroup>
                  ) : (
                    <FormGroup label={t("add_proxy.field_external_address")} fieldId="edit-external-port" isRequired>
                      <InlineAddressField
                        scheme={externalScheme}
                        onSchemeChange={v => { setExternalScheme(v); setExtHostErr(null); }}
                        host={externalHost}
                        onHostChange={v => { setExternalHost(v); setExtHostErr(null); }}
                        port={externalPort}
                        onPortChange={setExternalPort}
                        builtinSchemes={EXTERNAL_ADDRESS_BUILTIN_SCHEMES}
                        suggestedSchemes={extraSchemes}
                        isDisabled={isConfirming}
                        hostError={!!extHostErr}
                        portError={!!portErr}
                      />
                      {(portErr || extHostErr) && (
                        <FormHelperText>
                          <HelperText>
                            {extHostErr && <HelperTextItem variant="error">{extHostErr}</HelperTextItem>}
                            {portErr && <HelperTextItem variant="error">{portErr}</HelperTextItem>}
                          </HelperText>
                        </FormHelperText>
                      )}
                    </FormGroup>
                  )}

                  <TargetField
                    idPrefix="edit-"
                    scheme={targetScheme}
                    onSchemeChange={setTargetScheme}
                    host={targetHost}
                    onHostChange={setTargetHost}
                    port={targetPort}
                    onPortChange={setTargetPort}
                    skipVerify={tlsSkipVerify}
                    onSkipVerifyChange={setTlsSkipVerify}
                    hostError={targetHostErr ?? undefined}
                    portError={targetPortErr ?? undefined}
                    isDisabled={isConfirming}
                  />

                  {!proxy.namedServerKey && (
                    <TlsModeField id="edit-tls" value={tlsMode} onChange={setTlsModeChoice} publicName={publicName} isDisabled={isConfirming} onDemand={tlsOnDemand} onOnDemandChange={setTlsOnDemand} />
                  )}

                  <FormGroup label={t("add_proxy.field_compress")} fieldId="edit-compress">
                    <Checkbox
                      id="edit-compress"
                      label={t("add_proxy.field_compress_short")}
                      isChecked={compress}
                      onChange={(_e, checked) => setCompress(checked)}
                      isDisabled={isConfirming}
                    />
                  </FormGroup>
                  <SnippetImportsField value={imports} onChange={setImports} snippetSettings={proxy.snippetSettings} isDisabled={isConfirming} />
                </Form>
              ),
            },
            {
              key: "security",
              configured: flags.configured.security,
              hasError: flags.hasError.security,
              content: (
                <>
                  <BasicAuthSection value={basicAuth} onChange={setBasicAuth} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <ForwardAuthSection value={forwardAuth} onChange={setForwardAuth} isDisabled={isConfirming} uriError={forwardAuthErr ?? undefined} isExpanded onToggleExpanded={noop} />
                  {!proxy.namedServerKey && (
                    <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isConfirming} hostless={!externalHost.trim()} isExpanded onToggleExpanded={noop} />
                  )}
                </>
              ),
            },
            {
              key: "routing",
              configured: flags.configured.routing,
              content: (
                <>
                  <RouteMatchersSection value={matchers} onChange={v => { setMatchers(v); if (!isPathOnlyMatcher(v)) setHandlePath(false); }} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  {isPathOnlyMatcher(matchers) && (
                    <Checkbox
                      id="edit-proxy-handle-path"
                      label={t("handle_path.label")}
                      isChecked={handlePath}
                      onChange={(_e, v) => setHandlePath(v)}
                      isDisabled={isConfirming}
                    />
                  )}
                  <RewriteSection value={rewrite} onChange={setRewrite} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <ResponseHeadersSection value={responseHeaders} onChange={setResponseHeaders} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <NamedRouteField idPrefix="edit-proxy-" enabled={isNamedRoute} onEnabledChange={setIsNamedRoute} name={namedRouteName} onNameChange={setNamedRouteName} isDisabled={isConfirming} />
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
                    isDisabled={isConfirming}
                    isExpanded
                    onToggleExpanded={noop}
                  />
                  <LbRetrySection value={lbRetry} onChange={setLbRetry} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <TransportSection value={transport} onChange={setTransport} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                </>
              ),
            },
            {
              key: "logging",
              configured: flags.configured.logging,
              content: (
                <>
                  <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isConfirming} isExpanded onToggleExpanded={noop} />
                  <RequestBodyLimitField value={requestBodyMaxSize} onChange={setRequestBodyMaxSize} isDisabled={isConfirming} idPrefix="edit-proxy" />
                </>
              ),
            },
          ]}
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
                  externalHost: normalizeExternalHost(externalHost),
                  externalPort: port,
                  // id is intentionally left as proxy.id (via the ...proxy spread) — it still
                  // identifies *which* existing proxy this is even if the host/port changed as
                  // part of this edit. useProxies.editProxy recomputes the post-edit id itself.
                  targetScheme,
                  targetHost: targetHost.trim(),
                  targetPort: parseInt(targetPort, 10),
                  ...(proxy.namedServerKey ? { tls } : tlsModeToEntry(tlsMode, externalHost)),
                  tlsOnDemand: tlsMode !== "off" && tlsOnDemand ? true : undefined,
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
            <Button variant="primary" onClick={validateAndConfirm}>
              {t("edit_proxy.save_button")}
            </Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
