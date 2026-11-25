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
import { hasNestedBlocks } from "../api/siteTree";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { readProxyConf, parseConfExternalAddresses, CaddyApiError, CaddyfileError, saveWithDnsSecrets, routeHosts, hostsConflict, normalizeExternalHost, formatExternalAddressPreview } from "../api";
import { useSiteDns } from "./SiteDnsChallenge";
import { TlsModeField, hasPublicName, tlsModeOf, tlsModeToEntry, type TlsMode } from "./TlsModeField";
import { EXTERNAL_ADDRESS_BUILTIN_SCHEMES } from "./externalAddressSchemes";
import { externalHostFieldError } from "./externalHostField";
import { isValidPort } from "@rxtx4816/cockpit-plugin-base-react/lib/uri";
import type { ProxyEntry, ServerDef } from "../api";
import { SnippetImportsField } from "./SnippetImportsField";
import { InlineAddressField, TargetField, firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { ProxyTabs } from "./ProxyTabs";
import { proxyTabStateFlags, proxyTabStateFromEntry, proxyTabStateToEntry, useProxyTabState } from "./proxyTabState";

interface Props {
  proxy: ProxyEntry;
  /** See AddProxyDialog's existingRoutes: a conflict requires both a port and a host match (#139). */
  existingRoutes: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  /** Saves the text of the site's block as the Tree tab edited it (#350). */
  onSaveSiteText?: (text: string) => Promise<void>;
  onClose: () => void;
  onApiError?: (message: string) => void;
  servers?: ServerDef[];
}

export function EditProxyDialog({ proxy, onSaveSiteText, existingRoutes, onSave, onClose, onApiError, servers }: Props) {
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
  const [tabState, updateTabState] = useProxyTabState(proxyTabStateFromEntry(proxy));
  const [activeTab, setActiveTab] = useState<ProxyTabKey>("general");
  const [imports, setImports] = useState<string[] | undefined>(proxy.imports);
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
  const siteDns = useSiteDns(proxy.dnsChallenge, tlsMode === "acme");
  const tls = tlsMode !== "off";

  function portError(): string | null {
    const n = parseInt(externalPort, 10);
    if (!externalPort || isNaN(n)) return t("add_proxy.validation_port_number");
    if (!isValidPort(n)) return t("add_proxy.validation_port_range");
    if (existingRoutes.some(r =>
      r.externalPort === n &&
      hostsConflict(routeHosts(r), routeHosts({ externalHost: normalizeExternalHost(externalHost), matchers: tabState.matchers }))
    )) return t("add_proxy.validation_port_duplicate", { port: n });
    return null;
  }

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
    const after = proxyTabStateFlags(tabState, !!hostErr || !!portErr || !!targetHostErr || !!targetPortErr);
    const errorTab = firstTabWithError(after.hasError) ?? (!proxy.namedServerKey && siteDns.error(externalHost, tlsMode === "acme") ? "general" : undefined);
    if (errorTab) {
      setActiveTab(errorTab);
      return;
    }
    saveConfirm.confirm();
  }

  const portErr = proxy.namedServerKey ? null : portError();
  const generalHasError = !!extHostErr || !!portErr || !!targetHostErr || !!targetPortErr;
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

        {!!proxy.siteText && hasNestedBlocks(proxy.siteText) && (
          <Alert variant="info" isInline title={t("proxies.raw_blocks_notice")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
        )}

        <ProxyTabs
          state={tabState}
          onChange={updateTabState}
          active={activeTab}
          onSelect={setActiveTab}
          isDisabled={isConfirming}
          idPrefix="edit-proxy"
          siteText={proxy.siteText}
          onSaveSiteText={onSaveSiteText && (async text => { await onSaveSiteText(text); toast.success(t("tree.saved")); onClose(); })}
          showTls={!proxy.namedServerKey}
          hostless={!externalHost.trim()}
          generalHasError={generalHasError}
          general={
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
              <TlsModeField id="edit-tls" value={tlsMode} onChange={setTlsModeChoice} publicName={publicName} isDisabled={isConfirming} onDemand={tlsOnDemand} onOnDemandChange={setTlsOnDemand} dns={siteDns} host={externalHost} />
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
          }
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
                const dns = siteDns.plan(externalHost, !proxy.namedServerKey && tlsMode === "acme");
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
                  dnsChallenge: dns.config,
                  tlsSkipVerify: targetScheme === "https" ? tlsSkipVerify : false,
                  compress: compress || undefined,
                  label: label.trim() || undefined,
                  ...(await proxyTabStateToEntry(tabState)),
                  imports,
                };
                try {
                  await saveWithDnsSecrets(dns.secrets, () => onSave(entry));
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
