import { useState, useEffect, useCallback } from "react";
import {
  ActionGroup,
  Alert,
  Button,
  Checkbox,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Divider,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Spinner,
  TextInput,
  Title,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { readGlobalOptions, syncGlobalOptions, reloadService, fetchStorageInfo, checkStoragePathWritable } from "../api";
import type { GlobalOptions, StorageInfo } from "../api";
import { CertLifetimeSelect } from "./CertLifetimeSelect";
import { AccessLogSection, type AccessLogValues, accessLogConfigToValues, accessLogValuesToConfig } from "./AccessLogSection";

function isDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(v.trim());
}

// Caddy's internal-issuer `lifetime` accepts Go's standard duration units plus "d",
// but rejects "y" ("unknown unit y") — express a year as 365d instead.
function isCertLifetimeDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h|d)$/.test(v.trim());
}

function isRatio(v: string): boolean {
  if (!v) return true;
  const n = Number(v.trim());
  return !isNaN(n) && n > 0 && n < 1;
}

function isListenAddress(v: string): boolean {
  return !v || /^[\w.-]*:\d{1,5}$/.test(v.trim());
}

/** Builds a clickable URL for the metrics listen address — a bind-all address
 *  (e.g. ":2019") has no usable host of its own, so falls back to the current page's. */
function metricsLinkUrl(listenAddress: string, path: string): string | null {
  const m = listenAddress.trim().match(/^([\w.-]*):(\d{1,5})$/);
  if (!m) return null;
  const host = m[1] || window.location.hostname;
  return `http://${host}:${m[2]}${path.trim() || "/metrics"}`;
}

export function GlobalOptionsTab() {
  const { t } = useTranslation();
  const confirm = useConfirmAction();
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [reloadOk, setReloadOk] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [hasAnyOption, setHasAnyOption] = useState(true);

  const [httpPort, setHttpPort] = useState("");
  const [httpsPort, setHttpsPort] = useState("");
  const [debug, setDebug] = useState(false);
  const [gracePeriod, setGracePeriod] = useState("");
  const [shutdownDelay, setShutdownDelay] = useState("");
  const [email, setEmail] = useState("");
  const [acmeCA, setAcmeCA] = useState("");
  const [acmeCARoot, setAcmeCARoot] = useState("");
  const [acmeEabKeyId, setAcmeEabKeyId] = useState("");
  const [acmeEabMacKey, setAcmeEabMacKey] = useState("");
  const [onDemandEnabled, setOnDemandEnabled] = useState(false);
  const [onDemandAsk, setOnDemandAsk] = useState("");
  const [onDemandInterval, setOnDemandInterval] = useState("");
  const [onDemandBurst, setOnDemandBurst] = useState("");
  const [internalCertLifetime, setInternalCertLifetime] = useState("");
  const [renewalWindowRatio, setRenewalWindowRatio] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageInfoError, setStorageInfoError] = useState<string | null>(null);
  const [metricsEnabled, setMetricsEnabled] = useState(false);
  const [metricsListenAddress, setMetricsListenAddress] = useState("");
  const [metricsPath, setMetricsPath] = useState("");
  const [metricsPlainFormat, setMetricsPlainFormat] = useState(false);
  const [runtimeLog, setRuntimeLog] = useState<AccessLogValues>(accessLogConfigToValues(undefined));
  const [trustedProxiesEnabled, setTrustedProxiesEnabled] = useState(false);
  const [trustedProxiesRanges, setTrustedProxiesRanges] = useState("");
  const [trustedProxiesStrict, setTrustedProxiesStrict] = useState(false);
  const [trustedProxiesHeaders, setTrustedProxiesHeaders] = useState("");
  const [proxyProtocolEnabled, setProxyProtocolEnabled] = useState(false);
  const [proxyProtocolTimeout, setProxyProtocolTimeout] = useState("");
  const [proxyProtocolAllow, setProxyProtocolAllow] = useState("");

  const loadStorageInfo = useCallback((configuredPath: string | undefined) => {
    setStorageInfo(null);
    setStorageInfoError(null);
    fetchStorageInfo(configuredPath)
      .then(setStorageInfo)
      .catch(e => setStorageInfoError(e instanceof Error ? e.message : String(e)));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    readGlobalOptions()
      .then(opts => {
        setHasAnyOption(Object.keys(opts).length > 0);
        setHttpPort(opts.httpPort != null ? String(opts.httpPort) : "");
        setHttpsPort(opts.httpsPort != null ? String(opts.httpsPort) : "");
        setDebug(opts.debug ?? false);
        setGracePeriod(opts.gracePeriod ?? "");
        setShutdownDelay(opts.shutdownDelay ?? "");
        setEmail(opts.email ?? "");
        setAcmeCA(opts.acmeCA ?? "");
        setAcmeCARoot(opts.acmeCARoot ?? "");
        setAcmeEabKeyId(opts.acmeEabKeyId ?? "");
        setAcmeEabMacKey(opts.acmeEabMacKey ?? "");
        setOnDemandEnabled(opts.onDemandEnabled ?? false);
        setOnDemandAsk(opts.onDemandAsk ?? "");
        setOnDemandInterval(opts.onDemandInterval ?? "");
        setOnDemandBurst(opts.onDemandBurst != null ? String(opts.onDemandBurst) : "");
        setInternalCertLifetime(opts.internalCertLifetime ?? "");
        setRenewalWindowRatio(opts.renewalWindowRatio != null ? String(opts.renewalWindowRatio) : "");
        setStoragePath(opts.storagePath ?? "");
        loadStorageInfo(opts.storagePath);
        setMetricsEnabled(opts.metricsEnabled ?? false);
        setMetricsListenAddress(opts.metricsListenAddress ?? "");
        setMetricsPath(opts.metricsPath ?? "");
        setMetricsPlainFormat(opts.metricsPlainFormat ?? false);
        setRuntimeLog(accessLogConfigToValues(opts.runtimeLog));
        setTrustedProxiesEnabled(!!opts.trustedProxies);
        setTrustedProxiesRanges(opts.trustedProxies?.ranges.join(" ") ?? "");
        setTrustedProxiesStrict(opts.trustedProxies?.strict ?? false);
        setTrustedProxiesHeaders(opts.trustedProxies?.headers?.join(" ") ?? "");
        setProxyProtocolEnabled(!!opts.proxyProtocol);
        setProxyProtocolTimeout(opts.proxyProtocol?.timeout ?? "");
        setProxyProtocolAllow(opts.proxyProtocol?.allow?.join(" ") ?? "");
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [loadStorageInfo]);

  useEffect(() => { load(); }, [load]);

  function portError(v: string): string | null {
    if (!v) return null;
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1 || n > 65535) return t("global_opts.validation_port");
    return null;
  }

  const httpPortErr = portError(httpPort);
  const httpsPortErr = portError(httpsPort);
  const gracePeriodErr = !isDuration(gracePeriod) ? t("global_opts.validation_duration") : null;
  const shutdownDelayErr = !isDuration(shutdownDelay) ? t("global_opts.validation_duration") : null;
  const onDemandBurstErr = onDemandBurst && (isNaN(parseInt(onDemandBurst, 10)) || parseInt(onDemandBurst, 10) < 1)
    ? t("global_opts.validation_burst") : null;
  const onDemandIntervalErr = onDemandInterval && !isDuration(onDemandInterval) ? t("global_opts.validation_duration") : null;
  const internalCertLifetimeErr = !isCertLifetimeDuration(internalCertLifetime) ? t("global_opts.validation_cert_lifetime") : null;
  const renewalWindowRatioErr = !isRatio(renewalWindowRatio) ? t("global_opts.validation_ratio") : null;
  const metricsListenAddressErr = metricsEnabled && !metricsListenAddress.trim()
    ? t("global_opts.metrics_listen_address_required")
    : !isListenAddress(metricsListenAddress) ? t("global_opts.metrics_listen_address_invalid") : null;
  const metricsPathErr = metricsPath.trim() && !metricsPath.trim().startsWith("/") ? t("global_opts.metrics_path_invalid") : null;
  const trustedProxiesRangesErr = trustedProxiesEnabled && !trustedProxiesRanges.trim();
  const proxyProtocolTimeoutErr = proxyProtocolEnabled && !isDuration(proxyProtocolTimeout) ? t("global_opts.validation_duration") : null;
  const hasErrors = !!(
    httpPortErr || httpsPortErr || gracePeriodErr || shutdownDelayErr || onDemandBurstErr || onDemandIntervalErr
    || internalCertLifetimeErr || renewalWindowRatioErr || metricsListenAddressErr || metricsPathErr
    || trustedProxiesRangesErr || proxyProtocolTimeoutErr
  );

  const isConfirming = confirm.step !== "idle";
  const isSaving = confirm.step === "submitting";

  async function handleReload() {
    setReloading(true);
    setReloadError(null);
    try {
      await reloadService("caddy");
      setNeedsReload(false);
      setReloadOk(true);
      setTimeout(() => setReloadOk(false), 4000);
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (loadError) {
    return (
      <Alert variant="danger" isInline title={t("global_opts.load_error")}>
        {loadError}
        <Button variant="link" isInline onClick={load} style={{ marginLeft: "0.5rem" }}>{t("common.retry")}</Button>
      </Alert>
    );
  }

  return (
    <div style={{ maxWidth: "56rem" }}>
      <Title headingLevel="h3" style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
        {t("global_opts.title")}
      </Title>

      {reloadOk && (
        <Alert variant="success" isInline title={t("caddyfile.reloaded")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
      )}
      {needsReload && !reloadOk && (
        <Alert
          variant="warning"
          title={t("global_opts.needs_reload")}
          style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          actionLinks={
            <Button variant="warning" size="sm" isLoading={reloading} isDisabled={reloading} onClick={() => void handleReload()}>
              {t("service.reload")}
            </Button>
          }
        />
      )}
      {reloadError && (
        <Alert variant="danger" isInline title={reloadError} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
      )}

      <Alert variant="info" isInline title={t("global_opts.caddyfile_note")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />

      {!hasAnyOption && (
        <Alert
          variant="info"
          isInline
          title={t("global_opts.unmanaged_hint")}
          style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
        />
      )}

      <Form>
        {isConfirming && (
          <Alert
            variant="warning"
            isInline
            title={t("global_opts.confirm_body")}
            style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}
          />
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
          <FormGroup label={t("global_opts.http_port")} fieldId="go-http-port" style={{ flex: "1 1 10rem" }}>
            <TextInput
              id="go-http-port"
              value={httpPort}
              onChange={(_e, v) => setHttpPort(v)}
              placeholder="80"
              validated={httpPortErr ? "error" : "default"}
              isDisabled={isConfirming}
            />
            {httpPortErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{httpPortErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("global_opts.https_port")} fieldId="go-https-port" style={{ flex: "1 1 10rem" }}>
            <TextInput
              id="go-https-port"
              value={httpsPort}
              onChange={(_e, v) => setHttpsPort(v)}
              placeholder="443"
              validated={httpsPortErr ? "error" : "default"}
              isDisabled={isConfirming}
            />
            {httpsPortErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{httpsPortErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("global_opts.grace_period")} fieldId="go-grace-period" style={{ flex: "1 1 10rem" }}>
            <TextInput
              id="go-grace-period"
              value={gracePeriod}
              onChange={(_e, v) => setGracePeriod(v)}
              placeholder={t("global_opts.duration_placeholder")}
              validated={gracePeriodErr ? "error" : "default"}
              isDisabled={isConfirming}
            />
            {gracePeriodErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{gracePeriodErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("global_opts.shutdown_delay")} fieldId="go-shutdown-delay" style={{ flex: "1 1 10rem" }}>
            <TextInput
              id="go-shutdown-delay"
              value={shutdownDelay}
              onChange={(_e, v) => setShutdownDelay(v)}
              placeholder={t("global_opts.duration_placeholder")}
              validated={shutdownDelayErr ? "error" : "default"}
              isDisabled={isConfirming}
            />
            {shutdownDelayErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{shutdownDelayErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>
        </div>

        <FormGroup fieldId="go-debug">
          <Checkbox
            id="go-debug"
            label={t("global_opts.debug")}
            description={t("global_opts.debug_help")}
            isChecked={debug}
            onChange={(_e, v) => setDebug(v)}
            isDisabled={isConfirming}
          />
        </FormGroup>

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.acme_title")}
        </Title>
        <Alert variant="info" isInline title={t("global_opts.acme_note")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }} />

        <FormGroup label={t("global_opts.acme_email")} fieldId="go-email">
          <TextInput
            id="go-email"
            value={email}
            onChange={(_e, v) => setEmail(v)}
            placeholder="admin@example.com"
            isDisabled={isConfirming}
          />
          <FormHelperText>
            <HelperText><HelperTextItem>{t("global_opts.acme_email_help")}</HelperTextItem></HelperText>
          </FormHelperText>
        </FormGroup>

        <FormGroup label={t("global_opts.acme_ca")} fieldId="go-acme-ca">
          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
            {[
              { label: t("global_opts.acme_ca_le_prod"), url: "https://acme-v02.api.letsencrypt.org/directory" },
              { label: t("global_opts.acme_ca_le_staging"), url: "https://acme-staging-v02.api.letsencrypt.org/directory" },
              { label: t("global_opts.acme_ca_zerossl"), url: "https://acme.zerossl.com/v2/DV90" },
            ].map(({ label, url }) => (
              <Button
                key={url}
                variant={acmeCA === url ? "primary" : "secondary"}
                size="sm"
                onClick={() => setAcmeCA(url)}
                isDisabled={isConfirming}
              >
                {label}
              </Button>
            ))}
          </div>
          <TextInput
            id="go-acme-ca"
            value={acmeCA}
            onChange={(_e, v) => setAcmeCA(v)}
            placeholder={t("global_opts.acme_ca_placeholder")}
            isDisabled={isConfirming}
          />
          <FormHelperText>
            <HelperText><HelperTextItem>{t("global_opts.acme_ca_help")}</HelperTextItem></HelperText>
          </FormHelperText>
        </FormGroup>

        <FormGroup label={t("global_opts.acme_ca_root")} fieldId="go-acme-ca-root">
          <TextInput
            id="go-acme-ca-root"
            value={acmeCARoot}
            onChange={(_e, v) => setAcmeCARoot(v)}
            placeholder="/etc/caddy/acme-ca.pem"
            isDisabled={isConfirming}
          />
          <FormHelperText>
            <HelperText><HelperTextItem>{t("global_opts.acme_ca_root_help")}</HelperTextItem></HelperText>
          </FormHelperText>
        </FormGroup>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
          <FormGroup label={t("global_opts.acme_eab_key_id")} fieldId="go-eab-key-id" style={{ flex: "1 1 16rem" }}>
            <TextInput
              id="go-eab-key-id"
              value={acmeEabKeyId}
              onChange={(_e, v) => setAcmeEabKeyId(v)}
              placeholder={t("global_opts.acme_eab_placeholder")}
              isDisabled={isConfirming}
            />
          </FormGroup>

          <FormGroup label={t("global_opts.acme_eab_mac_key")} fieldId="go-eab-mac-key" style={{ flex: "1 1 16rem" }}>
            <TextInput
              id="go-eab-mac-key"
              value={acmeEabMacKey}
              onChange={(_e, v) => setAcmeEabMacKey(v)}
              placeholder={t("global_opts.acme_eab_placeholder")}
              isDisabled={isConfirming}
            />
            <FormHelperText>
              <HelperText><HelperTextItem>{t("global_opts.acme_eab_help")}</HelperTextItem></HelperText>
            </FormHelperText>
          </FormGroup>
        </div>

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.on_demand_title")}
        </Title>

        <FormGroup fieldId="go-on-demand-enabled">
          <Checkbox
            id="go-on-demand-enabled"
            label={t("global_opts.on_demand_enabled")}
            description={t("global_opts.on_demand_enabled_help")}
            isChecked={onDemandEnabled}
            onChange={(_e, v) => setOnDemandEnabled(v)}
            isDisabled={isConfirming}
          />
        </FormGroup>

        {onDemandEnabled && (
          <>
            {!onDemandAsk.trim() && (
              <Alert variant="warning" isInline title={t("global_opts.on_demand_no_ask_warning")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }} />
            )}
            <FormGroup label={t("global_opts.on_demand_ask")} fieldId="go-on-demand-ask">
              <TextInput
                id="go-on-demand-ask"
                value={onDemandAsk}
                onChange={(_e, v) => setOnDemandAsk(v)}
                placeholder="http://localhost:9090/check"
                isDisabled={isConfirming}
              />
              <FormHelperText>
                <HelperText><HelperTextItem>{t("global_opts.on_demand_ask_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            </FormGroup>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
              <FormGroup label={t("global_opts.on_demand_interval")} fieldId="go-on-demand-interval" style={{ flex: "1 1 12rem" }}>
                <TextInput
                  id="go-on-demand-interval"
                  value={onDemandInterval}
                  onChange={(_e, v) => setOnDemandInterval(v)}
                  placeholder={t("global_opts.duration_placeholder")}
                  validated={onDemandIntervalErr ? "error" : "default"}
                  isDisabled={isConfirming}
                />
                {onDemandIntervalErr && (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{onDemandIntervalErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>
              <FormGroup label={t("global_opts.on_demand_burst")} fieldId="go-on-demand-burst" style={{ flex: "1 1 12rem" }}>
                <TextInput
                  id="go-on-demand-burst"
                  value={onDemandBurst}
                  onChange={(_e, v) => setOnDemandBurst(v)}
                  placeholder="5"
                  validated={onDemandBurstErr ? "error" : "default"}
                  isDisabled={isConfirming}
                />
                {onDemandBurstErr && (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{onDemandBurstErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("global_opts.on_demand_burst_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              </FormGroup>
            </div>
          </>
        )}

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.internal_tls_title")}
        </Title>
        <Alert variant="info" isInline title={t("global_opts.internal_tls_note")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }} />

        <FormGroup label={t("global_opts.internal_cert_lifetime")} fieldId="go-internal-cert-lifetime">
          <CertLifetimeSelect
            value={internalCertLifetime}
            onChange={setInternalCertLifetime}
            isDisabled={isConfirming}
          />
          <TextInput
            id="go-internal-cert-lifetime"
            value={internalCertLifetime}
            onChange={(_e, v) => setInternalCertLifetime(v)}
            placeholder="90d"
            validated={internalCertLifetimeErr ? "error" : "default"}
            isDisabled={isConfirming}
            style={{ marginTop: "0.4rem" }}
          />
          {internalCertLifetimeErr ? (
            <FormHelperText>
              <HelperText><HelperTextItem variant="error">{internalCertLifetimeErr}</HelperTextItem></HelperText>
            </FormHelperText>
          ) : (
            <FormHelperText>
              <HelperText><HelperTextItem>{t("global_opts.internal_cert_lifetime_help")}</HelperTextItem></HelperText>
            </FormHelperText>
          )}
        </FormGroup>

        <FormGroup label={t("global_opts.renewal_window_ratio")} fieldId="go-renewal-window-ratio">
          <TextInput
            id="go-renewal-window-ratio"
            value={renewalWindowRatio}
            onChange={(_e, v) => setRenewalWindowRatio(v)}
            placeholder="0.33"
            validated={renewalWindowRatioErr ? "error" : "default"}
            isDisabled={isConfirming}
          />
          {renewalWindowRatioErr ? (
            <FormHelperText>
              <HelperText><HelperTextItem variant="error">{renewalWindowRatioErr}</HelperTextItem></HelperText>
            </FormHelperText>
          ) : (
            <FormHelperText>
              <HelperText><HelperTextItem>{t("global_opts.renewal_window_ratio_help")}</HelperTextItem></HelperText>
            </FormHelperText>
          )}
        </FormGroup>

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.storage_title")}
        </Title>

        {storageInfoError && (
          <Alert variant="danger" isInline title={t("global_opts.storage_info_error")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            {storageInfoError}
          </Alert>
        )}
        {!storageInfo && !storageInfoError && (
          <div style={{ display: "flex", justifyContent: "center", padding: "1rem" }}>
            <Spinner size="md" />
          </div>
        )}
        {storageInfo && (
          <DescriptionList isHorizontal isCompact style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <DescriptionListGroup>
              <DescriptionListTerm>{t("global_opts.storage_path")}</DescriptionListTerm>
              <DescriptionListDescription>
                <code>{storageInfo.path}</code>
                {storageInfo.isDefault && ` (${t("global_opts.storage_path_default_tag")})`}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>{t("global_opts.storage_disk_usage")}</DescriptionListTerm>
              <DescriptionListDescription>{storageInfo.diskUsage ?? t("global_opts.storage_unknown")}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>{t("global_opts.storage_cert_count")}</DescriptionListTerm>
              <DescriptionListDescription>
                {storageInfo.certificateCount ?? t("global_opts.storage_unknown")}
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>
        )}

        <FormGroup label={t("global_opts.storage_root")} fieldId="go-storage-root">
          <TextInput
            id="go-storage-root"
            value={storagePath}
            onChange={(_e, v) => setStoragePath(v)}
            placeholder="/var/lib/caddy"
            isDisabled={isConfirming}
          />
          <FormHelperText>
            <HelperText><HelperTextItem>{t("global_opts.storage_root_help")}</HelperTextItem></HelperText>
          </FormHelperText>
        </FormGroup>

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.metrics_title")}
        </Title>

        <FormGroup fieldId="go-metrics-enabled">
          <Checkbox
            id="go-metrics-enabled"
            label={t("global_opts.metrics_enabled")}
            description={t("global_opts.metrics_enabled_help")}
            isChecked={metricsEnabled}
            onChange={(_e, v) => setMetricsEnabled(v)}
            isDisabled={isConfirming}
          />
        </FormGroup>

        {metricsEnabled && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
              <FormGroup label={t("global_opts.metrics_listen_address")} fieldId="go-metrics-listen-address" style={{ flex: "1 1 14rem" }}>
                <TextInput
                  id="go-metrics-listen-address"
                  value={metricsListenAddress}
                  onChange={(_e, v) => setMetricsListenAddress(v)}
                  placeholder=":2019"
                  validated={metricsListenAddressErr ? "error" : "default"}
                  isDisabled={isConfirming}
                />
                {metricsListenAddressErr ? (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{metricsListenAddressErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                ) : (
                  <FormHelperText>
                    <HelperText><HelperTextItem>{t("global_opts.metrics_listen_address_help")}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup label={t("global_opts.metrics_path")} fieldId="go-metrics-path" style={{ flex: "1 1 14rem" }}>
                <TextInput
                  id="go-metrics-path"
                  value={metricsPath}
                  onChange={(_e, v) => setMetricsPath(v)}
                  placeholder="/metrics"
                  validated={metricsPathErr ? "error" : "default"}
                  isDisabled={isConfirming}
                />
                {metricsPathErr ? (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{metricsPathErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                ) : (
                  <FormHelperText>
                    <HelperText><HelperTextItem>{t("global_opts.metrics_path_help")}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>
            </div>

            <FormGroup fieldId="go-metrics-plain-format">
              <Checkbox
                id="go-metrics-plain-format"
                label={t("global_opts.metrics_plain_format")}
                description={t("global_opts.metrics_plain_format_help")}
                isChecked={metricsPlainFormat}
                onChange={(_e, v) => setMetricsPlainFormat(v)}
                isDisabled={isConfirming}
              />
            </FormGroup>

            {!metricsListenAddressErr && metricsListenAddress.trim() && (() => {
              const url = metricsLinkUrl(metricsListenAddress, metricsPath);
              return url ? (
                <FormGroup fieldId="go-metrics-link">
                  <a href={url} target="_blank" rel="noreferrer">{t("global_opts.metrics_link")}</a>
                </FormGroup>
              ) : null;
            })()}
          </>
        )}

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.runtime_log_title")}
        </Title>
        <Alert variant="info" isInline title={t("global_opts.runtime_log_note")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }} />

        <AccessLogSection
          idPrefix="rl"
          title={t("global_opts.runtime_log_section_title")}
          titleOn={t("global_opts.runtime_log_section_title_on")}
          enableLabel={t("global_opts.runtime_log_enable")}
          value={runtimeLog}
          onChange={setRuntimeLog}
          isDisabled={isConfirming}
        />

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.trusted_proxies_title")}
        </Title>
        <Alert variant="info" isInline title={t("global_opts.trusted_proxies_note")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }} />

        <FormGroup fieldId="go-trusted-proxies-enabled">
          <Checkbox
            id="go-trusted-proxies-enabled"
            label={t("global_opts.trusted_proxies_enable")}
            isChecked={trustedProxiesEnabled}
            onChange={(_e, v) => setTrustedProxiesEnabled(v)}
            isDisabled={isConfirming}
          />
        </FormGroup>

        {trustedProxiesEnabled && (
          <>
            <FormGroup label={t("global_opts.trusted_proxies_ranges")} fieldId="go-trusted-proxies-ranges" isRequired>
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setTrustedProxiesRanges(prev => prev.trim() ? `${prev.trim()} private_ranges` : "private_ranges")}
                  isDisabled={isConfirming}
                >
                  {t("global_opts.trusted_proxies_private_ranges_button")}
                </Button>
              </div>
              <TextInput
                id="go-trusted-proxies-ranges"
                value={trustedProxiesRanges}
                onChange={(_e, v) => setTrustedProxiesRanges(v)}
                placeholder="private_ranges 203.0.113.0/24"
                validated={trustedProxiesRangesErr ? "error" : "default"}
                isDisabled={isConfirming}
              />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant={trustedProxiesRangesErr ? "error" : "default"}>
                    {trustedProxiesRangesErr
                      ? t("global_opts.trusted_proxies_ranges_required")
                      : t("global_opts.trusted_proxies_ranges_help")}
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>

            <FormGroup label={t("global_opts.trusted_proxies_headers")} fieldId="go-trusted-proxies-headers">
              <TextInput
                id="go-trusted-proxies-headers"
                value={trustedProxiesHeaders}
                onChange={(_e, v) => setTrustedProxiesHeaders(v)}
                placeholder="X-Forwarded-For"
                isDisabled={isConfirming}
              />
              <FormHelperText>
                <HelperText><HelperTextItem>{t("global_opts.trusted_proxies_headers_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            </FormGroup>

            <FormGroup fieldId="go-trusted-proxies-strict">
              <Checkbox
                id="go-trusted-proxies-strict"
                label={t("global_opts.trusted_proxies_strict")}
                description={t("global_opts.trusted_proxies_strict_help")}
                isChecked={trustedProxiesStrict}
                onChange={(_e, v) => setTrustedProxiesStrict(v)}
                isDisabled={isConfirming}
              />
            </FormGroup>
          </>
        )}

        <Divider style={{ margin: "var(--pf-v6-global--spacer--md) 0 var(--pf-v6-global--spacer--sm)" }} />

        <Title headingLevel="h4" size="md" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
          {t("global_opts.proxy_protocol_title")}
        </Title>
        <Alert variant="info" isInline title={t("global_opts.proxy_protocol_note")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }} />

        <FormGroup fieldId="go-proxy-protocol-enabled">
          <Checkbox
            id="go-proxy-protocol-enabled"
            label={t("global_opts.proxy_protocol_enable")}
            isChecked={proxyProtocolEnabled}
            onChange={(_e, v) => setProxyProtocolEnabled(v)}
            isDisabled={isConfirming}
          />
        </FormGroup>

        {proxyProtocolEnabled && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
              <FormGroup label={t("global_opts.proxy_protocol_allow")} fieldId="go-proxy-protocol-allow" style={{ flex: "2 1 16rem" }}>
                <TextInput
                  id="go-proxy-protocol-allow"
                  value={proxyProtocolAllow}
                  onChange={(_e, v) => setProxyProtocolAllow(v)}
                  placeholder="10.0.0.0/8 192.168.1.1/32"
                  isDisabled={isConfirming}
                />
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("global_opts.proxy_protocol_allow_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              </FormGroup>

              <FormGroup label={t("global_opts.proxy_protocol_timeout")} fieldId="go-proxy-protocol-timeout" style={{ flex: "1 1 10rem" }}>
                <TextInput
                  id="go-proxy-protocol-timeout"
                  value={proxyProtocolTimeout}
                  onChange={(_e, v) => setProxyProtocolTimeout(v)}
                  placeholder="2s"
                  validated={proxyProtocolTimeoutErr ? "error" : "default"}
                  isDisabled={isConfirming}
                />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem variant={proxyProtocolTimeoutErr ? "error" : "default"}>
                      {proxyProtocolTimeoutErr ?? t("global_opts.proxy_protocol_timeout_help")}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            </div>
          </>
        )}

        {confirm.error != null && (
          <Alert variant="danger" isInline title={t("global_opts.save_error")}>
            {confirm.error || t("global_opts.save_error_unknown")}
          </Alert>
        )}
        {saveOk && (
          <Alert variant="success" isInline title={t("global_opts.save_ok")} />
        )}

        <ActionGroup>
          {isConfirming ? (
            <>
              <Button
                variant="primary"
                isLoading={isSaving}
                isDisabled={isSaving}
                onClick={() => void confirm.submit(async () => {
                  const opts: GlobalOptions = {
                    httpPort: httpPort ? parseInt(httpPort, 10) : undefined,
                    httpsPort: httpsPort ? parseInt(httpsPort, 10) : undefined,
                    debug: debug || undefined,
                    gracePeriod: gracePeriod.trim() || undefined,
                    shutdownDelay: shutdownDelay.trim() || undefined,
                    email: email.trim() || undefined,
                    acmeCA: acmeCA.trim() || undefined,
                    acmeCARoot: acmeCARoot.trim() || undefined,
                    acmeEabKeyId: acmeEabKeyId.trim() || undefined,
                    acmeEabMacKey: acmeEabMacKey.trim() || undefined,
                    onDemandEnabled: onDemandEnabled || undefined,
                    onDemandAsk: onDemandEnabled ? (onDemandAsk.trim() || undefined) : undefined,
                    onDemandInterval: onDemandEnabled ? (onDemandInterval.trim() || undefined) : undefined,
                    onDemandBurst: onDemandEnabled && onDemandBurst.trim() ? parseInt(onDemandBurst, 10) : undefined,
                    internalCertLifetime: internalCertLifetime.trim() || undefined,
                    renewalWindowRatio: renewalWindowRatio.trim() ? Number(renewalWindowRatio.trim()) : undefined,
                    storagePath: storagePath.trim() || undefined,
                    metricsEnabled: metricsEnabled || undefined,
                    metricsListenAddress: metricsEnabled ? (metricsListenAddress.trim() || undefined) : undefined,
                    metricsPath: metricsEnabled ? (metricsPath.trim() || undefined) : undefined,
                    metricsPlainFormat: metricsEnabled ? (metricsPlainFormat || undefined) : undefined,
                    runtimeLog: accessLogValuesToConfig(runtimeLog),
                    trustedProxies: trustedProxiesEnabled && trustedProxiesRanges.trim() ? {
                      ranges: trustedProxiesRanges.trim().split(/\s+/),
                      strict: trustedProxiesStrict || undefined,
                      headers: trustedProxiesHeaders.trim() ? trustedProxiesHeaders.trim().split(/\s+/) : undefined,
                    } : undefined,
                    proxyProtocol: proxyProtocolEnabled ? {
                      timeout: proxyProtocolTimeout.trim() || undefined,
                      allow: proxyProtocolAllow.trim() ? proxyProtocolAllow.trim().split(/\s+/) : undefined,
                    } : undefined,
                  };
                  // An unwritable storage path isn't caught by Caddy's own config
                  // validation (it only checks config shape, not whether the process can
                  // actually provision its PKI app there) — checked separately so a bad
                  // path is refused now instead of only failing the next time Caddy starts
                  // or reloads, at which point it can no longer provision anything at all.
                  if (opts.storagePath) {
                    const writeErr = await checkStoragePathWritable(opts.storagePath);
                    if (writeErr) throw new Error(t("global_opts.storage_not_writable", { error: writeErr }));
                  }
                  await syncGlobalOptions(opts).catch(e => {
                    throw e instanceof Error ? e : new Error(String(e));
                  });
                  setHasAnyOption(Object.values(opts).some(v => v !== undefined));
                  setNeedsReload(true);
                  setSaveOk(true);
                  setTimeout(() => setSaveOk(false), 4000);
                  loadStorageInfo(opts.storagePath);
                })}
              >
                {t("service.confirm_action")}
              </Button>
              <Button variant="link" onClick={confirm.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={confirm.confirm} isDisabled={hasErrors}>
                {t("global_opts.save_button")}
              </Button>
              <Button variant="link" onClick={load}>{t("common.cancel")}</Button>
            </>
          )}
        </ActionGroup>
      </Form>
    </div>
  );
}
