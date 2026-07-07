import { useState } from "react";
import {
  ExpandableSection,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { LbRetryConfig } from "../api";
import { SectionActions } from "./SectionActions";

export interface LbRetryValues {
  retries: string;
  tryDuration: string;
  tryInterval: string;
  unhealthyStatus: string;
}

const LB_RETRY_EMPTY: LbRetryValues = { retries: "", tryDuration: "", tryInterval: "", unhealthyStatus: "" };
const LB_RETRY_DEFAULTS: LbRetryValues = { retries: "3", tryDuration: "5s", tryInterval: "250ms", unhealthyStatus: "500 502 503" };

export function lbRetryConfigToValues(cfg: LbRetryConfig | undefined): LbRetryValues {
  if (!cfg) return LB_RETRY_EMPTY;
  return {
    retries: cfg.retries != null ? String(cfg.retries) : "",
    tryDuration: cfg.tryDuration ?? "",
    tryInterval: cfg.tryInterval ?? "",
    unhealthyStatus: cfg.unhealthyStatus?.length ? cfg.unhealthyStatus.join(" ") : "",
  };
}

export function lbRetryValuesToConfig(v: LbRetryValues): LbRetryConfig | undefined {
  const retries = v.retries.trim() ? parseInt(v.retries, 10) : undefined;
  const unhealthyStatus = v.unhealthyStatus.trim()
    ? v.unhealthyStatus.trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n))
    : undefined;
  const cfg: LbRetryConfig = {
    retries: retries != null && !isNaN(retries) ? retries : undefined,
    tryDuration: v.tryDuration.trim() || undefined,
    tryInterval: v.tryInterval.trim() || undefined,
    unhealthyStatus: unhealthyStatus?.length ? unhealthyStatus : undefined,
  };
  return (cfg.retries != null || cfg.tryDuration || cfg.tryInterval || cfg.unhealthyStatus) ? cfg : undefined;
}

function isDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(v.trim());
}

function isStatusList(v: string): boolean {
  if (!v.trim()) return true;
  return v.trim().split(/\s+/).every(s => /^\d{3}$/.test(s));
}

interface Props {
  value: LbRetryValues;
  onChange: (v: LbRetryValues) => void;
  isDisabled?: boolean;
}

export function validateLbRetry(v: LbRetryValues): string | null {
  if (v.retries.trim() && (isNaN(parseInt(v.retries, 10)) || parseInt(v.retries, 10) < 0)) return "lb_retry.validation_retries";
  if (!isDuration(v.tryDuration)) return "lb_retry.validation_duration";
  if (!isDuration(v.tryInterval)) return "lb_retry.validation_duration";
  if (!isStatusList(v.unhealthyStatus)) return "lb_retry.validation_status";
  return null;
}

export function LbRetrySection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const hasValues = !!(value.retries || value.tryDuration || value.tryInterval || value.unhealthyStatus);
  const [expanded, setExpanded] = useState(hasValues);

  function set(key: keyof LbRetryValues, v: string) {
    onChange({ ...value, [key]: v });
  }

  const retriesErr = value.retries.trim() && (isNaN(parseInt(value.retries, 10)) || parseInt(value.retries, 10) < 0);
  const tryDurationErr = !isDuration(value.tryDuration);
  const tryIntervalErr = !isDuration(value.tryInterval);
  const statusErr = !isStatusList(value.unhealthyStatus);

  return (
    <ExpandableSection
      toggleText={t("lb_retry.section_title")}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => onChange(LB_RETRY_EMPTY)}
        onDefaults={() => onChange(LB_RETRY_DEFAULTS)}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        <FormGroup label={t("lb_retry.retries")} fieldId="lbr-retries" style={{ flex: "1 1 8rem" }}>
          <TextInput
            id="lbr-retries"
            type="number"
            value={value.retries}
            onChange={(_e, v) => set("retries", v)}
            placeholder="3"
            isDisabled={isDisabled}
            validated={retriesErr ? "error" : "default"}
          />
        </FormGroup>
        <FormGroup label={t("lb_retry.try_duration")} fieldId="lbr-try-duration" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="lbr-try-duration"
            value={value.tryDuration}
            onChange={(_e, v) => set("tryDuration", v)}
            placeholder="5s"
            isDisabled={isDisabled}
            validated={tryDurationErr ? "error" : "default"}
          />
        </FormGroup>
        <FormGroup label={t("lb_retry.try_interval")} fieldId="lbr-try-interval" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="lbr-try-interval"
            value={value.tryInterval}
            onChange={(_e, v) => set("tryInterval", v)}
            placeholder="250ms"
            isDisabled={isDisabled}
            validated={tryIntervalErr ? "error" : "default"}
          />
        </FormGroup>
      </div>
      <FormGroup label={t("lb_retry.unhealthy_status")} fieldId="lbr-unhealthy-status" style={{ marginTop: "0.6rem" }}>
        <TextInput
          id="lbr-unhealthy-status"
          value={value.unhealthyStatus}
          onChange={(_e, v) => set("unhealthyStatus", v)}
          placeholder="500 502 503"
          isDisabled={isDisabled}
          validated={statusErr ? "error" : "default"}
        />
        <FormHelperText>
          <HelperText>
            <HelperTextItem variant={statusErr ? "error" : "default"}>
              {statusErr ? t("lb_retry.validation_status") : t("lb_retry.unhealthy_status_help")}
            </HelperTextItem>
          </HelperText>
        </FormHelperText>
      </FormGroup>
    </ExpandableSection>
  );
}
