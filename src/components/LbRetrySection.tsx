import { useState } from "react";
import {
  ExpandableSection,
  FormGroup,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { LbRetryConfig } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface LbRetryValues {
  retries: string;
  tryDuration: string;
  tryInterval: string;
  failDuration: string;
  maxFails: string;
  unhealthyStatus: string;
  healthUri: string;
  healthInterval: string;
  healthTimeout: string;
  healthStatus: string;
}

const LB_RETRY_EMPTY: LbRetryValues = {
  retries: "", tryDuration: "", tryInterval: "",
  failDuration: "", maxFails: "", unhealthyStatus: "",
  healthUri: "", healthInterval: "", healthTimeout: "", healthStatus: "",
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
    failDuration: cfg.failDuration ?? "",
    maxFails: cfg.maxFails != null ? String(cfg.maxFails) : "",
    unhealthyStatus: cfg.unhealthyStatus?.length ? cfg.unhealthyStatus.join(" ") : "",
    healthUri: cfg.healthUri ?? "",
    healthInterval: cfg.healthInterval ?? "",
    healthTimeout: cfg.healthTimeout ?? "",
    healthStatus: cfg.healthStatus ?? "",
  };
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
    failDuration: v.failDuration.trim() || undefined,
    maxFails: parseIntOrUndefined(v.maxFails),
    unhealthyStatus: unhealthyStatus?.length ? unhealthyStatus : undefined,
    healthUri: v.healthUri.trim() || undefined,
    healthInterval: v.healthInterval.trim() || undefined,
    healthTimeout: v.healthTimeout.trim() || undefined,
    healthStatus: v.healthStatus.trim().toLowerCase() || undefined,
  };
  for (const k of Object.keys(cfg) as Array<keyof LbRetryConfig>) if (cfg[k] == null) delete cfg[k];
  return Object.keys(cfg).length ? cfg : undefined;
}

function isDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(v.trim());
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
  if (!isStatusList(v.unhealthyStatus)) return "lb_retry.validation_status";
  if (!isPositiveInt(v.maxFails)) return "lb_retry.validation_max_fails";
  if (v.healthUri.trim() && !v.healthUri.trim().startsWith("/")) return "lb_retry.validation_health_uri";
  if (!isHealthStatus(v.healthStatus)) return "lb_retry.validation_health_status";
  if ((v.healthInterval.trim() || v.healthTimeout.trim() || v.healthStatus.trim()) && !v.healthUri.trim()) return "lb_retry.validation_needs_health_uri";
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

  function field(key: keyof LbRetryValues, id: string, label: string, placeholder: string, invalid: boolean, opts: { type?: "number"; flex?: string } = {}) {
    return (
      <FormGroup label={label} fieldId={id} style={{ flex: opts.flex ?? "1 1 10rem" }}>
        <TextInput
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
    : !isDuration(value.tryDuration) || !isDuration(value.tryInterval) ? "lb_retry.validation_duration" : null;
  const passiveErr = !isDuration(value.failDuration) ? "lb_retry.validation_duration"
    : !isStatusList(value.unhealthyStatus) ? "lb_retry.validation_status"
    : !isPositiveInt(value.maxFails) ? "lb_retry.validation_max_fails" : null;
  const warning = lbRetryWarning(value);
  const uriErr = !!value.healthUri.trim() && !value.healthUri.trim().startsWith("/");
  const needsUri = !value.healthUri.trim() && !!(value.healthInterval.trim() || value.healthTimeout.trim() || value.healthStatus.trim());
  const activeErr = uriErr ? "lb_retry.validation_health_uri"
    : !isDuration(value.healthInterval) || !isDuration(value.healthTimeout) ? "lb_retry.validation_duration"
    : !isHealthStatus(value.healthStatus) ? "lb_retry.validation_health_status"
    : needsUri ? "lb_retry.validation_needs_health_uri" : null;
  const row = { display: "flex", flexWrap: "wrap" as const, gap: "1rem" };
  const heading = { marginTop: "1rem", marginBottom: "0.4rem", fontWeight: 600 };

  return (
    <ExpandableSection
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
        {field("retries", "lbr-retries", t("lb_retry.retries"), "3", retriesErr, { type: "number", flex: "1 1 8rem" })}
        {field("tryDuration", "lbr-try-duration", t("lb_retry.try_duration"), "5s", !isDuration(value.tryDuration))}
        {field("tryInterval", "lbr-try-interval", t("lb_retry.try_interval"), "250ms", !isDuration(value.tryInterval))}
      </div>
      <HelperText data-testid="lbr-retry-help" style={{ marginTop: "0.3rem" }}>
        {retryErr && <HelperTextItem variant="error">{t(retryErr)}</HelperTextItem>}
      </HelperText>

      <div style={heading}>{t("lb_retry.passive_title")}</div>
      <div style={row}>
        {field("failDuration", "lbr-fail-duration", t("lb_retry.fail_duration"), "30s", !isDuration(value.failDuration))}
        {field("maxFails", "lbr-max-fails", t("lb_retry.max_fails"), "1", !isPositiveInt(value.maxFails), { type: "number", flex: "1 1 8rem" })}
      </div>
      <FormGroup label={t("lb_retry.unhealthy_status")} fieldId="lbr-unhealthy-status" style={{ marginTop: "0.6rem" }}>
        <TextInput
          id="lbr-unhealthy-status"
          value={value.unhealthyStatus}
          onChange={(_e, v) => set("unhealthyStatus", v)}
          placeholder="500 502 503"
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
        {field("healthUri", "lbr-health-uri", t("lb_retry.health_uri"), "/healthz", uriErr || needsUri)}
        {field("healthInterval", "lbr-health-interval", t("lb_retry.health_interval"), "30s", !isDuration(value.healthInterval))}
        {field("healthTimeout", "lbr-health-timeout", t("lb_retry.health_timeout"), "5s", !isDuration(value.healthTimeout))}
        {field("healthStatus", "lbr-health-status", t("lb_retry.health_status"), "2xx", !isHealthStatus(value.healthStatus), { flex: "1 1 8rem" })}
      </div>
      <HelperText data-testid="lbr-active-help" style={{ marginTop: "0.3rem" }}>
        <HelperTextItem variant={activeErr ? "error" : "default"}>
          {t(activeErr ?? "lb_retry.active_help")}
        </HelperTextItem>
      </HelperText>
    </ExpandableSection>
  );
}
