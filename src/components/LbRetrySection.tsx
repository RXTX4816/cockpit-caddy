import { useState } from "react";
import {
  FormGroup,
  HelperText,
  HelperTextItem,
  TextArea,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ResettableTextInput, SectionShell } from "./sectionLayout";
import type { LbRetryConfig } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface LbRetryValues {
  retries: string;
  tryDuration: string;
  tryInterval: string;
  /** Space-separated HTTP methods for lb_retry_match (#327). */
  retryMethods: string;
  failDuration: string;
  maxFails: string;
  unhealthyStatus: string;
  healthUri: string;
  healthInterval: string;
  healthTimeout: string;
  healthStatus: string;
  healthPort: string;
  /** One header per line: name, whitespace, value. */
  healthHeaders: string;
  healthPasses: string;
  healthFails: string;
}

const LB_RETRY_EMPTY: LbRetryValues = {
  retries: "", tryDuration: "", tryInterval: "", retryMethods: "",
  failDuration: "", maxFails: "", unhealthyStatus: "",
  healthUri: "", healthInterval: "", healthTimeout: "", healthStatus: "",
  healthPort: "", healthHeaders: "", healthPasses: "", healthFails: "",
};
// A retry preset, plus passive checks that actually run: unhealthy_status does nothing in
// Caddy without fail_duration (#252). Active checks stay off; they need a path on the backend.
const LB_RETRY_DEFAULTS: LbRetryValues = {
  ...LB_RETRY_EMPTY, retries: "3", tryDuration: "5s", tryInterval: "250ms", failDuration: "30s", unhealthyStatus: "500 502 503",
};

export function lbRetryConfigToValues(cfg: LbRetryConfig | undefined): LbRetryValues {
  if (!cfg) return LB_RETRY_EMPTY;
  return {
    retries: cfg.retries != null ? String(cfg.retries) : "",
    tryDuration: cfg.tryDuration ?? "",
    tryInterval: cfg.tryInterval ?? "",
    retryMethods: (cfg.retryMethods ?? []).join(" "),
    failDuration: cfg.failDuration ?? "",
    maxFails: cfg.maxFails != null ? String(cfg.maxFails) : "",
    unhealthyStatus: cfg.unhealthyStatus?.length ? cfg.unhealthyStatus.join(" ") : "",
    healthUri: cfg.healthUri ?? "",
    healthInterval: cfg.healthInterval ?? "",
    healthTimeout: cfg.healthTimeout ?? "",
    healthStatus: cfg.healthStatus ?? "",
    healthPort: cfg.healthPort != null ? String(cfg.healthPort) : "",
    healthHeaders: Object.entries(cfg.healthHeaders ?? {}).flatMap(([name, vals]) => vals.map(val => `${name} ${val}`)).join("\n"),
    healthPasses: cfg.healthPasses != null ? String(cfg.healthPasses) : "",
    healthFails: cfg.healthFails != null ? String(cfg.healthFails) : "",
  };
}

/** The non-blank lines of the headers field, split at the first whitespace. */
function healthHeaderLines(v: string): Array<{ name: string; value: string }> {
  return v.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\S+)\s+(.*)$/);
    return m ? { name: m[1], value: m[2].trim() } : { name: l, value: "" };
  });
}

function parseHealthHeaders(v: string): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const { name, value } of healthHeaderLines(v)) (out[name] ??= []).push(value);
  return Object.keys(out).length ? out : undefined;
}

/** Every line is a header name (an HTTP token) and a value. */
function isHeaderList(v: string): boolean {
  return healthHeaderLines(v).every(h => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.name) && h.value !== "");
}

function isPort(v: string): boolean {
  return !v.trim() || (/^\d+$/.test(v.trim()) && +v >= 1 && +v <= 65535);
}

function parseIntOrUndefined(v: string): number | undefined {
  const n = v.trim() ? parseInt(v, 10) : NaN;
  return isNaN(n) ? undefined : n;
}

export function lbRetryValuesToConfig(v: LbRetryValues): LbRetryConfig | undefined {
  const unhealthyStatus = v.unhealthyStatus.trim()
    ? v.unhealthyStatus.trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n))
    : undefined;
  const cfg: LbRetryConfig = {
    retries: parseIntOrUndefined(v.retries),
    tryDuration: v.tryDuration.trim() || undefined,
    tryInterval: v.tryInterval.trim() || undefined,
    retryMethods: v.retryMethods.trim() ? v.retryMethods.trim().toUpperCase().split(/\s+/) : undefined,
    failDuration: v.failDuration.trim() || undefined,
    maxFails: parseIntOrUndefined(v.maxFails),
    unhealthyStatus: unhealthyStatus?.length ? unhealthyStatus : undefined,
    healthUri: v.healthUri.trim() || undefined,
    healthInterval: v.healthInterval.trim() || undefined,
    healthTimeout: v.healthTimeout.trim() || undefined,
    healthStatus: v.healthStatus.trim().toLowerCase() || undefined,
    healthPort: parseIntOrUndefined(v.healthPort),
    healthHeaders: parseHealthHeaders(v.healthHeaders),
    healthPasses: parseIntOrUndefined(v.healthPasses),
    healthFails: parseIntOrUndefined(v.healthFails),
  };
  for (const k of Object.keys(cfg) as Array<keyof LbRetryConfig>) if (cfg[k] == null) delete cfg[k];
  return Object.keys(cfg).length ? cfg : undefined;
}

function isDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(v.trim());
}

function isMethodList(v: string): boolean {
  return !v.trim() || v.trim().split(/\s+/).every(m => /^[A-Za-z]+$/.test(m));
}

function isStatusList(v: string): boolean {
  if (!v.trim()) return true;
  return v.trim().split(/\s+/).every(s => /^\d{3}$/.test(s));
}

function isPositiveInt(v: string): boolean {
  return !v.trim() || /^[1-9]\d*$/.test(v.trim());
}

function isHealthStatus(v: string): boolean {
  return !v.trim() || /^([1-5]\d\d|[1-5]xx)$/i.test(v.trim());
}

interface Props {
  value: LbRetryValues;
  onChange: (v: LbRetryValues) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function validateLbRetry(v: LbRetryValues): string | null {
  if (v.retries.trim() && (isNaN(parseInt(v.retries, 10)) || parseInt(v.retries, 10) < 0)) return "lb_retry.validation_retries";
  for (const d of [v.tryDuration, v.tryInterval, v.failDuration, v.healthInterval, v.healthTimeout]) {
    if (!isDuration(d)) return "lb_retry.validation_duration";
  }
  if (!isMethodList(v.retryMethods)) return "lb_retry.validation_methods";
  if (!isStatusList(v.unhealthyStatus)) return "lb_retry.validation_status";
  if (!isPositiveInt(v.maxFails)) return "lb_retry.validation_max_fails";
  return activeCheckError(v);
}

/** Active checks run once a path or a port is set; the other options only tune them. */
function needsHealthTarget(v: LbRetryValues): boolean {
  return !v.healthUri.trim() && !v.healthPort.trim()
    && !!(v.healthInterval.trim() || v.healthTimeout.trim() || v.healthStatus.trim() || v.healthHeaders.trim() || v.healthPasses.trim() || v.healthFails.trim());
}

function activeCheckError(v: LbRetryValues): string | null {
  if (v.healthUri.trim() && !v.healthUri.trim().startsWith("/")) return "lb_retry.validation_health_uri";
  if (!isPort(v.healthPort)) return "lb_retry.validation_health_port";
  if (!isDuration(v.healthInterval) || !isDuration(v.healthTimeout)) return "lb_retry.validation_duration";
  if (!isHealthStatus(v.healthStatus)) return "lb_retry.validation_health_status";
  if (!isPositiveInt(v.healthPasses) || !isPositiveInt(v.healthFails)) return "lb_retry.validation_health_count";
  if (!isHeaderList(v.healthHeaders)) return "lb_retry.validation_health_headers";
  if (needsHealthTarget(v)) return "lb_retry.validation_needs_health_target";
  return null;
}

/**
 * Caddy keeps passive health checks off without fail_duration (#252), and the writer leaves
 * unhealthy_status/max_fails out until one is set. Only a warning: proxies saved by older
 * versions have status codes without a fail duration and must stay editable.
 */
export function lbRetryWarning(v: LbRetryValues): string | null {
  return (v.unhealthyStatus.trim() || v.maxFails.trim()) && !v.failDuration.trim() ? "lb_retry.validation_needs_fail_duration" : null;
}

export function LbRetrySection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const hasValues = Object.values(value).some(Boolean);
  const [internalExpanded, setInternalExpanded] = useState(hasValues);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function set(key: keyof LbRetryValues, v: string) {
    onChange({ ...value, [key]: v });
  }

  // Placeholders: "Default: …" where Caddy has a default, "e.g. …" where the option is off
  // until set (#301). Caddy accepts any 2xx when no expected status is set.
  function field(key: keyof LbRetryValues, id: string, label: string, placeholder: string, invalid: boolean, opts: { type?: "number"; flex?: string } = {}) {
    return (
      <FormGroup label={label} fieldId={id} style={{ flex: opts.flex ?? "1 1 10rem" }}>
        <ResettableTextInput
          id={id}
          type={opts.type}
          value={value[key]}
          onChange={(_e, v) => set(key, v)}
          placeholder={placeholder}
          isDisabled={isDisabled}
          validated={invalid ? "error" : "default"}
        />
      </FormGroup>
    );
  }

  const retriesErr = !!value.retries.trim() && (isNaN(parseInt(value.retries, 10)) || parseInt(value.retries, 10) < 0);
  // Each group shows only its own problems.
  const retryErr = retriesErr ? "lb_retry.validation_retries"
    : !isDuration(value.tryDuration) || !isDuration(value.tryInterval) ? "lb_retry.validation_duration"
    : !isMethodList(value.retryMethods) ? "lb_retry.validation_methods" : null;
  const passiveErr = !isDuration(value.failDuration) ? "lb_retry.validation_duration"
    : !isStatusList(value.unhealthyStatus) ? "lb_retry.validation_status"
    : !isPositiveInt(value.maxFails) ? "lb_retry.validation_max_fails" : null;
  const warning = lbRetryWarning(value);
  const uriErr = !!value.healthUri.trim() && !value.healthUri.trim().startsWith("/");
  const needsTarget = needsHealthTarget(value);
  const activeErr = activeCheckError(value);
  const row = { display: "flex", flexWrap: "wrap" as const, gap: "1rem" };
  const heading = { marginTop: "1rem", marginBottom: "0.4rem", fontWeight: 600 };

  return (
    <SectionShell
      heading={t("lb_retry.heading")}
      toggleContent={<>{t("lb_retry.section_title")}{hasValues && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => onChange(LB_RETRY_EMPTY)}
        onDefaults={() => onChange(LB_RETRY_DEFAULTS)}
        isDisabled={isDisabled}
      />
      <div style={row}>
        {field("retries", "lbr-retries", t("lb_retry.retries"), t("common.example_value", { value: "3" }), retriesErr, { type: "number", flex: "1 1 8rem" })}
        {field("tryDuration", "lbr-try-duration", t("lb_retry.try_duration"), t("common.example_value", { value: "5s" }), !isDuration(value.tryDuration))}
        {field("tryInterval", "lbr-try-interval", t("lb_retry.try_interval"), t("common.default_value", { value: "250ms" }), !isDuration(value.tryInterval))}
        {field("retryMethods", "lbr-retry-methods", t("lb_retry.retry_methods"), t("common.example_value", { value: "GET HEAD" }), !isMethodList(value.retryMethods))}
      </div>
      <HelperText data-testid="lbr-retry-help" style={{ marginTop: "0.3rem" }}>
        {retryErr && <HelperTextItem variant="error">{t(retryErr)}</HelperTextItem>}
      </HelperText>

      <div style={heading}>{t("lb_retry.passive_title")}</div>
      <div style={row}>
        {field("failDuration", "lbr-fail-duration", t("lb_retry.fail_duration"), t("common.example_value", { value: "30s" }), !isDuration(value.failDuration))}
        {field("maxFails", "lbr-max-fails", t("lb_retry.max_fails"), t("common.default_value", { value: "1" }), !isPositiveInt(value.maxFails), { type: "number", flex: "1 1 8rem" })}
      </div>
      <FormGroup label={t("lb_retry.unhealthy_status")} fieldId="lbr-unhealthy-status" style={{ marginTop: "0.6rem" }}>
        <ResettableTextInput
          id="lbr-unhealthy-status"
          value={value.unhealthyStatus}
          onChange={(_e, v) => set("unhealthyStatus", v)}
          placeholder={t("common.example_value", { value: "500 502 503" })}
          isDisabled={isDisabled}
          validated={!isStatusList(value.unhealthyStatus) ? "error" : "default"}
        />
      </FormGroup>
      <HelperText data-testid="lbr-passive-help" style={{ marginTop: "0.3rem" }}>
        <HelperTextItem variant={passiveErr ? "error" : warning ? "warning" : "default"}>
          {t(passiveErr ?? warning ?? "lb_retry.passive_help")}
        </HelperTextItem>
      </HelperText>

      <div style={heading}>{t("lb_retry.active_title")}</div>
      <div style={row}>
        {field("healthUri", "lbr-health-uri", t("lb_retry.health_uri"), t("common.example_value", { value: "/healthz" }), uriErr || needsTarget)}
        {field("healthPort", "lbr-health-port", t("lb_retry.health_port"), t("common.default_value", { value: t("lb_retry.health_port_default") }), !isPort(value.healthPort) || needsTarget, { type: "number", flex: "1 1 8rem" })}
        {field("healthInterval", "lbr-health-interval", t("lb_retry.health_interval"), t("common.default_value", { value: "30s" }), !isDuration(value.healthInterval))}
        {field("healthTimeout", "lbr-health-timeout", t("lb_retry.health_timeout"), t("common.default_value", { value: "5s" }), !isDuration(value.healthTimeout))}
        {field("healthStatus", "lbr-health-status", t("lb_retry.health_status"), t("common.default_value", { value: "2xx" }), !isHealthStatus(value.healthStatus), { flex: "1 1 8rem" })}
        {field("healthPasses", "lbr-health-passes", t("lb_retry.health_passes"), t("common.default_value", { value: "1" }), !isPositiveInt(value.healthPasses), { type: "number", flex: "1 1 8rem" })}
        {field("healthFails", "lbr-health-fails", t("lb_retry.health_fails"), t("common.default_value", { value: "1" }), !isPositiveInt(value.healthFails), { type: "number", flex: "1 1 8rem" })}
      </div>
      <FormGroup label={t("lb_retry.health_headers")} fieldId="lbr-health-headers" style={{ marginTop: "0.6rem" }}>
        <TextArea
          id="lbr-health-headers"
          value={value.healthHeaders}
          onChange={(_e, v) => set("healthHeaders", v)}
          placeholder={t("common.example_value", { value: "Host app.internal" })}
          isDisabled={isDisabled}
          validated={!isHeaderList(value.healthHeaders) ? "error" : "default"}
          rows={2}
          resizeOrientation="vertical"
          aria-describedby="lbr-health-headers-help"
        />
        <HelperText id="lbr-health-headers-help"><HelperTextItem>{t("lb_retry.health_headers_help")}</HelperTextItem></HelperText>
      </FormGroup>
      <HelperText data-testid="lbr-active-help" style={{ marginTop: "0.3rem" }}>
        <HelperTextItem variant={activeErr ? "error" : "default"}>
          {t(activeErr ?? "lb_retry.active_help")}
        </HelperTextItem>
      </HelperText>
    </SectionShell>
  );
}
