import { useState, useEffect, useCallback } from "react";
import {
  ActionGroup,
  Alert,
  Button,
  Checkbox,
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
import { readGlobalOptions, syncGlobalOptions, reloadService } from "../api";
import type { GlobalOptions } from "../api";
import { CertLifetimeSelect } from "./CertLifetimeSelect";

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
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

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
  const hasErrors = !!(
    httpPortErr || httpsPortErr || gracePeriodErr || shutdownDelayErr || onDemandBurstErr || onDemandIntervalErr
    || internalCertLifetimeErr || renewalWindowRatioErr
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
    <div style={{ maxWidth: "36rem" }}>
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

        <FormGroup label={t("global_opts.http_port")} fieldId="go-http-port">
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

        <FormGroup label={t("global_opts.https_port")} fieldId="go-https-port">
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

        <FormGroup label={t("global_opts.grace_period")} fieldId="go-grace-period">
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

        <FormGroup label={t("global_opts.shutdown_delay")} fieldId="go-shutdown-delay">
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

        <FormGroup label={t("global_opts.acme_eab_key_id")} fieldId="go-eab-key-id">
          <TextInput
            id="go-eab-key-id"
            value={acmeEabKeyId}
            onChange={(_e, v) => setAcmeEabKeyId(v)}
            placeholder={t("global_opts.acme_eab_placeholder")}
            isDisabled={isConfirming}
          />
        </FormGroup>

        <FormGroup label={t("global_opts.acme_eab_mac_key")} fieldId="go-eab-mac-key">
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
            <FormGroup label={t("global_opts.on_demand_interval")} fieldId="go-on-demand-interval">
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
            <FormGroup label={t("global_opts.on_demand_burst")} fieldId="go-on-demand-burst">
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
                  };
                  await syncGlobalOptions(opts).catch(e => {
                    throw e instanceof Error ? e : new Error(String(e));
                  });
                  setHasAnyOption(Object.values(opts).some(v => v !== undefined));
                  setNeedsReload(true);
                  setSaveOk(true);
                  setTimeout(() => setSaveOk(false), 4000);
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
