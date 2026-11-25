import { useState } from "react";
import {
  Checkbox,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Radio,
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ResettableTextInput, SectionShell } from "./sectionLayout";
import type { AccessLogConfig, AccessLogFormat, AccessLogLevel, AccessLogOutput, LogFieldFilter } from "../api";
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
  /** One `field filter` per line (#334), e.g. `request>headers>Authorization delete`. */
  fieldFilters: string;
  /** Caddy's own log only: logger namespaces to take in or leave out, space-separated (#334). */
  include: string;
  exclude: string;
  /** `log_skip` (#334): paths whose requests are not logged, space-separated. */
  skipPaths: string;
}

const FILTER_LINE = /^\S+\s+(delete|hash|replace\s+\S.*|ip_mask\s+\d+(\s+\d+)?)$/;

/** A filter line Caddy would not take: an unknown filter, a replace without a value, an ip_mask without a length. */
export function validateFieldFilters(text: string): boolean {
  return text.split("\n").map(l => l.trim()).filter(Boolean).some(l => !FILTER_LINE.test(l));
}

export function fieldFiltersToText(filters: LogFieldFilter[] | undefined): string {
  return (filters ?? []).map(f => f.filter === "replace" ? `${f.field} replace ${f.value ?? ""}`
    : f.filter === "ip_mask" ? `${f.field} ip_mask ${f.ipv4 ?? 32}${f.ipv6 != null ? ` ${f.ipv6}` : ""}`
    : `${f.field} ${f.filter}`).join("\n");
}

export function fieldFiltersFromText(text: string): LogFieldFilter[] | undefined {
  const out: LogFieldFilter[] = [];
  for (const line of text.split("\n").map(l => l.trim()).filter(Boolean)) {
    if (!FILTER_LINE.test(line)) continue;
    const [field, filter, ...args] = line.split(/\s+/);
    if (filter === "replace") out.push({ field, filter, value: args.join(" ") });
    else if (filter === "ip_mask") out.push({ field, filter, ipv4: parseInt(args[0], 10), ...(args[1] ? { ipv6: parseInt(args[1], 10) } : {}) });
    else out.push({ field, filter: filter as "delete" | "hash" });
  }
  return out.length ? out : undefined;
}

interface Props {
  value: AccessLogValues;
  onChange: (v: AccessLogValues) => void;
  isDisabled?: boolean;
  /** Distinguishes element ids when this section appears more than once on the same page
   *  (e.g. a per-site access log alongside the global runtime logger, #158). */
  idPrefix?: string;
  /** Overrides the toggle/enable copy — used to relabel this identically-shaped section
   *  for Caddy's global runtime/error logger (#158) instead of a per-site access log. */
  title?: string;
  titleOn?: string;
  enableLabel?: string;
  /** The heading inside a tab (#291); the global runtime logger isn't shown in one. */
  heading?: string;
  /** Caddy's own log can also take in or leave out other loggers' entries (#334). */
  showLoggerFilters?: boolean;
  /** A site's own log can leave out the requests to noisy paths (#334). */
  showSkipPaths?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

const OUTPUTS: AccessLogOutput[] = ["stderr", "stdout", "file", "discard"];
const FORMATS: Array<AccessLogFormat | ""> = ["", "json", "console"];
const LEVELS: Array<AccessLogLevel | ""> = ["", "DEBUG", "INFO", "WARN", "ERROR"];

const ACCESS_LOG_DEFAULTS: AccessLogValues = { enabled: true, output: "stderr", filePath: "", format: "", level: "", rollSizeMb: "", rollKeepCount: "", rollKeepDays: "", rollCompress: true, fieldFilters: "", include: "", exclude: "", skipPaths: "" };
const ACCESS_LOG_EMPTY: AccessLogValues = { enabled: false, output: "stderr", filePath: "", format: "", level: "", rollSizeMb: "", rollKeepCount: "", rollKeepDays: "", rollCompress: true, fieldFilters: "", include: "", exclude: "", skipPaths: "" };

export function AccessLogSection({ value, onChange, isDisabled, idPrefix = "al", title, titleOn, enableLabel, heading, showLoggerFilters, showSkipPaths, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(value.enabled);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function set(patch: Partial<AccessLogValues>) {
    onChange({ ...value, ...patch });
  }

  const filePathErr = accessLogHasError(value)
    ? t("access_log.file_path_required")
    : null;

  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  return (
    <SectionShell
      heading={heading ?? t("access_log.heading")}
      toggleText={value.enabled ? (titleOn ?? t("access_log.section_title_on")) : (title ?? t("access_log.section_title"))}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => { onChange(ACCESS_LOG_EMPTY); setExpanded(false); }}
        onDefaults={() => { onChange(ACCESS_LOG_DEFAULTS); setExpanded(true); }}
        isDisabled={isDisabled}
      />
      <FormGroup fieldId={id("enabled")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <Checkbox
          id={id("enabled")}
          label={enableLabel ?? t("access_log.enable")}
          isChecked={value.enabled}
          onChange={(_e, v) => set({ enabled: v })}
          isDisabled={isDisabled}
        />
      </FormGroup>

      {value.enabled && (
        <>
          <FormGroup label={t("access_log.output")} fieldId={id("output")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {OUTPUTS.map(o => (
                <Radio
                  key={o}
                  id={id(`output-${o}`)}
                  name={id("output")}
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
            <FormGroup label={t("access_log.file_path")} fieldId={id("file-path")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
              <TextInput
                id={id("file-path")}
                value={value.filePath}
                onChange={(_e, v) => set({ filePath: v })}
                placeholder={t("common.example_value", { value: "/var/log/caddy/access.log" })}
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
            <FormGroup label={t("access_log.roll_title")} fieldId={id("roll")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
                <FormGroup label={t("access_log.roll_size_mb")} fieldId={id("roll-size")} style={{ flex: "1 1 8rem" }}>
                  <ResettableTextInput
                    id={id("roll-size")}
                    type="number"
                    value={value.rollSizeMb}
                    onChange={(_e, v) => set({ rollSizeMb: v })}
                    placeholder={t("common.default_value", { value: "100" })}
                    isDisabled={isDisabled}
                  />
                </FormGroup>
                <FormGroup label={t("access_log.roll_keep_count")} fieldId={id("roll-keep")} style={{ flex: "1 1 8rem" }}>
                  <ResettableTextInput
                    id={id("roll-keep")}
                    type="number"
                    value={value.rollKeepCount}
                    onChange={(_e, v) => set({ rollKeepCount: v })}
                    placeholder={t("common.default_value", { value: "10" })}
                    isDisabled={isDisabled}
                  />
                </FormGroup>
                <FormGroup label={t("access_log.roll_keep_days")} fieldId={id("roll-keep-days")} style={{ flex: "1 1 8rem" }}>
                  <ResettableTextInput
                    id={id("roll-keep-days")}
                    type="number"
                    value={value.rollKeepDays}
                    onChange={(_e, v) => set({ rollKeepDays: v })}
                    placeholder={t("common.default_value", { value: "90" })}
                    isDisabled={isDisabled}
                  />
                </FormGroup>
              </div>
              <FormHelperText>
                <HelperText><HelperTextItem>{t("access_log.roll_help")}</HelperTextItem></HelperText>
              </FormHelperText>
              <Checkbox
                id={id("roll-compress")}
                label={t("access_log.roll_compress")}
                isChecked={value.rollCompress}
                onChange={(_e, v) => set({ rollCompress: v })}
                isDisabled={isDisabled}
                style={{ marginTop: "0.4rem" }}
              />
            </FormGroup>
          )}

          <FormGroup label={t("access_log.format")} fieldId={id("format")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {FORMATS.map(f => (
                <Radio
                  key={f || "default"}
                  id={id(`format-${f || "default"}`)}
                  name={id("format")}
                  label={t(`access_log.format_${f || "default"}`)}
                  value={f}
                  isChecked={value.format === f}
                  onChange={() => set({ format: f })}
                  isDisabled={isDisabled}
                />
              ))}
            </div>
          </FormGroup>

          <FormGroup label={t("access_log.field_filters")} fieldId={id("field-filters")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <TextArea
              id={id("field-filters")}
              value={value.fieldFilters}
              onChange={(_e, v) => set({ fieldFilters: v })}
              rows={3}
              placeholder={"request>headers>Authorization delete\nrequest>remote_ip ip_mask 24 64"}
              validated={validateFieldFilters(value.fieldFilters) ? "error" : "default"}
              isDisabled={isDisabled}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={validateFieldFilters(value.fieldFilters) ? "error" : "default"}>
                  {validateFieldFilters(value.fieldFilters) ? t("access_log.field_filters_invalid") : t("access_log.field_filters_help")}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          {showSkipPaths && (
            <FormGroup label={t("access_log.skip_paths")} fieldId={id("skip-paths")} style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
              <TextInput id={id("skip-paths")} value={value.skipPaths} onChange={(_e, v) => set({ skipPaths: v })} placeholder="/health* /ping" isDisabled={isDisabled} />
              <FormHelperText><HelperText><HelperTextItem>{t("access_log.skip_paths_help")}</HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
          )}

          {showLoggerFilters && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
              <FormGroup label={t("access_log.include")} fieldId={id("include")} style={{ flex: "1 1 14rem" }}>
                <TextInput id={id("include")} value={value.include} onChange={(_e, v) => set({ include: v })} placeholder="http.log.access" isDisabled={isDisabled} />
                <FormHelperText><HelperText><HelperTextItem>{t("access_log.include_help")}</HelperTextItem></HelperText></FormHelperText>
              </FormGroup>
              <FormGroup label={t("access_log.exclude")} fieldId={id("exclude")} style={{ flex: "1 1 14rem" }}>
                <TextInput id={id("exclude")} value={value.exclude} onChange={(_e, v) => set({ exclude: v })} placeholder="http.log.access.log0" isDisabled={isDisabled} />
                <FormHelperText><HelperText><HelperTextItem>{t("access_log.exclude_help")}</HelperTextItem></HelperText></FormHelperText>
              </FormGroup>
            </div>
          )}

          <FormGroup label={t("access_log.level")} fieldId={id("level")}>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {LEVELS.map(l => (
                <Radio
                  key={l || "default"}
                  id={id(`level-${l || "default"}`)}
                  name={id("level")}
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
    </SectionShell>
  );
}

/** File output without a path, or a field filter line Caddy rejects; Save jumps to the tab that holds it. */
export function accessLogHasError(v: AccessLogValues): boolean {
  return v.enabled && ((v.output === "file" && !v.filePath.trim()) || validateFieldFilters(v.fieldFilters));
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
    fieldFilters: fieldFiltersFromText(v.fieldFilters),
    include: v.include.trim() ? v.include.trim().split(/\s+/) : undefined,
    exclude: v.exclude.trim() ? v.exclude.trim().split(/\s+/) : undefined,
    skipPaths: v.skipPaths.trim() ? v.skipPaths.trim().split(/\s+/) : undefined,
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
    fieldFilters: fieldFiltersToText(cfg?.fieldFilters),
    include: cfg?.include?.join(" ") ?? "",
    exclude: cfg?.exclude?.join(" ") ?? "",
    skipPaths: cfg?.skipPaths?.join(" ") ?? "",
  };
}
