import { useState, useEffect, useCallback } from "react";
import {
  ActionGroup,
  Alert,
  Button,
  Checkbox,
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
import { readGlobalOptions, syncGlobalOptions, reloadService, CaddyfileError } from "../api";
import type { GlobalOptions } from "../api";

function isDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(v.trim());
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

  const [httpPort, setHttpPort] = useState("");
  const [httpsPort, setHttpsPort] = useState("");
  const [debug, setDebug] = useState(false);
  const [gracePeriod, setGracePeriod] = useState("");
  const [shutdownDelay, setShutdownDelay] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    readGlobalOptions()
      .then(opts => {
        setHttpPort(opts.httpPort != null ? String(opts.httpPort) : "");
        setHttpsPort(opts.httpsPort != null ? String(opts.httpsPort) : "");
        setDebug(opts.debug ?? false);
        setGracePeriod(opts.gracePeriod ?? "");
        setShutdownDelay(opts.shutdownDelay ?? "");
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
  const hasErrors = !!(httpPortErr || httpsPortErr || gracePeriodErr || shutdownDelayErr);

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

        {confirm.error && (
          <Alert variant="danger" isInline title={t("global_opts.save_error")}>
            {confirm.error}
          </Alert>
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
                  };
                  try {
                    await syncGlobalOptions(opts);
                  } catch (e) {
                    if (e instanceof CaddyfileError) throw new Error(e.message);
                    throw e;
                  }
                  setNeedsReload(true);
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
