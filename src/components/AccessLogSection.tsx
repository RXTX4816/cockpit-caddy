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

export interface AccessLogValues {
  enabled: boolean;
  output: AccessLogOutput;
  filePath: string;
  format: AccessLogFormat | "";
  level: AccessLogLevel | "";
}

interface Props {
  value: AccessLogValues;
  onChange: (v: AccessLogValues) => void;
  isDisabled?: boolean;
}

const OUTPUTS: AccessLogOutput[] = ["stderr", "stdout", "file", "discard"];
const FORMATS: Array<AccessLogFormat | ""> = ["", "json", "console"];
const LEVELS: Array<AccessLogLevel | ""> = ["", "DEBUG", "INFO", "WARN", "ERROR"];

export function AccessLogSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();

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
    >
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
              {filePathErr && (
                <FormHelperText>
                  <HelperText><HelperTextItem variant="error">{filePathErr}</HelperTextItem></HelperText>
                </FormHelperText>
              )}
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
  return {
    output: v.output,
    filePath: v.output === "file" ? v.filePath.trim() : undefined,
    format: v.format || undefined,
    level: v.level || undefined,
  };
}

export function accessLogConfigToValues(cfg: AccessLogConfig | undefined): AccessLogValues {
  return {
    enabled: !!cfg,
    output: cfg?.output ?? "stderr",
    filePath: cfg?.filePath ?? "",
    format: cfg?.format ?? "",
    level: cfg?.level ?? "",
  };
}
