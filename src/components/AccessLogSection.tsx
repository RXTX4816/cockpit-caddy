import { useState } from "react";
import {
  Checkbox,
  ExpandableSection,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Radio,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { AccessLogConfig, AccessLogFormat, AccessLogLevel, AccessLogOutput } from "../api";
import { SectionActions } from "./SectionActions";

export interface AccessLogValues {
  enabled: boolean;
  output: AccessLogOutput;
  filePath: string;
  format: AccessLogFormat | "";
  level: AccessLogLevel | "";
  /** Log rotation (#155) — only applicable when output === "file". */
  rollSizeMb: string;
  rollKeepCount: string;
  rollKeepDays: string;
  rollCompress: boolean;
}

interface Props {
  value: AccessLogValues;
  onChange: (v: AccessLogValues) => void;
  isDisabled?: boolean;
}

const OUTPUTS: AccessLogOutput[] = ["stderr", "stdout", "file", "discard"];
const FORMATS: Array<AccessLogFormat | ""> = ["", "json", "console"];
const LEVELS: Array<AccessLogLevel | ""> = ["", "DEBUG", "INFO", "WARN", "ERROR"];

const ACCESS_LOG_DEFAULTS: AccessLogValues = { enabled: true, output: "stderr", filePath: "", format: "", level: "", rollSizeMb: "", rollKeepCount: "", rollKeepDays: "", rollCompress: true };
const ACCESS_LOG_EMPTY: AccessLogValues = { enabled: false, output: "stderr", filePath: "", format: "", level: "", rollSizeMb: "", rollKeepCount: "", rollKeepDays: "", rollCompress: true };

export function AccessLogSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(value.enabled);

  function set(patch: Partial<AccessLogValues>) {
    onChange({ ...value, ...patch });
  }

  const filePathErr = value.enabled && value.output === "file" && !value.filePath.trim()
    ? t("access_log.file_path_required")
    : null;

  return (
    <ExpandableSection
      toggleText={value.enabled ? t("access_log.section_title_on") : t("access_log.section_title")}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => { onChange(ACCESS_LOG_EMPTY); setExpanded(false); }}
        onDefaults={() => { onChange(ACCESS_LOG_DEFAULTS); setExpanded(true); }}
        isDisabled={isDisabled}
      />
      <FormGroup fieldId="al-enabled" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <Checkbox
          id="al-enabled"
          label={t("access_log.enable")}
          isChecked={value.enabled}
          onChange={(_e, v) => set({ enabled: v })}
          isDisabled={isDisabled}
        />
      </FormGroup>

      {value.enabled && (
        <>
          <FormGroup label={t("access_log.output")} fieldId="al-output" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {OUTPUTS.map(o => (
                <Radio
                  key={o}
                  id={`al-output-${o}`}
                  name="al-output"
                  label={t(`access_log.output_${o}`)}
                  value={o}
                  isChecked={value.output === o}
                  onChange={() => set({ output: o })}
                  isDisabled={isDisabled}
                />
              ))}
            </div>
          </FormGroup>

          {value.output === "file" && (
            <FormGroup label={t("access_log.file_path")} fieldId="al-file-path" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
              <TextInput
                id="al-file-path"
                value={value.filePath}
                onChange={(_e, v) => set({ filePath: v })}
                placeholder="/var/log/caddy/access.log"
                validated={filePathErr ? "error" : "default"}
                isDisabled={isDisabled}
              />
              {filePathErr ? (
                <FormHelperText>
                  <HelperText><HelperTextItem variant="error">{filePathErr}</HelperTextItem></HelperText>
                </FormHelperText>
              ) : (
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("access_log.file_path_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              )}
            </FormGroup>
          )}

          {value.output === "file" && (
            <FormGroup label={t("access_log.roll_title")} fieldId="al-roll" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
                <FormGroup label={t("access_log.roll_size_mb")} fieldId="al-roll-size" style={{ flex: "1 1 8rem" }}>
                  <TextInput
                    id="al-roll-size"
                    type="number"
                    value={value.rollSizeMb}
                    onChange={(_e, v) => set({ rollSizeMb: v })}
                    placeholder="100"
                    isDisabled={isDisabled}
                  />
                </FormGroup>
                <FormGroup label={t("access_log.roll_keep_count")} fieldId="al-roll-keep" style={{ flex: "1 1 8rem" }}>
                  <TextInput
                    id="al-roll-keep"
                    type="number"
                    value={value.rollKeepCount}
                    onChange={(_e, v) => set({ rollKeepCount: v })}
                    placeholder="10"
                    isDisabled={isDisabled}
                  />
                </FormGroup>
                <FormGroup label={t("access_log.roll_keep_days")} fieldId="al-roll-keep-days" style={{ flex: "1 1 8rem" }}>
                  <TextInput
                    id="al-roll-keep-days"
                    type="number"
                    value={value.rollKeepDays}
                    onChange={(_e, v) => set({ rollKeepDays: v })}
                    placeholder="30"
                    isDisabled={isDisabled}
                  />
                </FormGroup>
              </div>
              <FormHelperText>
                <HelperText><HelperTextItem>{t("access_log.roll_help")}</HelperTextItem></HelperText>
              </FormHelperText>
              <Checkbox
                id="al-roll-compress"
                label={t("access_log.roll_compress")}
                isChecked={value.rollCompress}
                onChange={(_e, v) => set({ rollCompress: v })}
                isDisabled={isDisabled}
                style={{ marginTop: "0.4rem" }}
              />
            </FormGroup>
          )}

          <FormGroup label={t("access_log.format")} fieldId="al-format" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {FORMATS.map(f => (
                <Radio
                  key={f || "default"}
                  id={`al-format-${f || "default"}`}
                  name="al-format"
                  label={t(`access_log.format_${f || "default"}`)}
                  value={f}
                  isChecked={value.format === f}
                  onChange={() => set({ format: f })}
                  isDisabled={isDisabled}
                />
              ))}
            </div>
          </FormGroup>

          <FormGroup label={t("access_log.level")} fieldId="al-level">
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {LEVELS.map(l => (
                <Radio
                  key={l || "default"}
                  id={`al-level-${l || "default"}`}
                  name="al-level"
                  label={t(`access_log.level_${l || "default"}`)}
                  value={l}
                  isChecked={value.level === l}
                  onChange={() => set({ level: l })}
                  isDisabled={isDisabled}
                />
              ))}
            </div>
          </FormGroup>
        </>
      )}
    </ExpandableSection>
  );
}

export function accessLogValuesToConfig(v: AccessLogValues): AccessLogConfig | undefined {
  if (!v.enabled) return undefined;
  const isFile = v.output === "file";
  return {
    output: v.output,
    filePath: isFile ? v.filePath.trim() : undefined,
    format: v.format || undefined,
    level: v.level || undefined,
    rollSizeMb: isFile && v.rollSizeMb.trim() ? parseInt(v.rollSizeMb, 10) : undefined,
    rollKeepCount: isFile && v.rollKeepCount.trim() ? parseInt(v.rollKeepCount, 10) : undefined,
    rollKeepDays: isFile && v.rollKeepDays.trim() ? parseInt(v.rollKeepDays, 10) : undefined,
    rollCompress: isFile && !v.rollCompress ? false : undefined,
  };
}

export function accessLogConfigToValues(cfg: AccessLogConfig | undefined): AccessLogValues {
  return {
    enabled: !!cfg,
    output: cfg?.output ?? "stderr",
    filePath: cfg?.filePath ?? "",
    format: cfg?.format ?? "",
    level: cfg?.level ?? "",
    rollSizeMb: cfg?.rollSizeMb != null ? String(cfg.rollSizeMb) : "",
    rollKeepCount: cfg?.rollKeepCount != null ? String(cfg.rollKeepCount) : "",
    rollKeepDays: cfg?.rollKeepDays != null ? String(cfg.rollKeepDays) : "",
    rollCompress: cfg?.rollCompress !== false,
  };
}
