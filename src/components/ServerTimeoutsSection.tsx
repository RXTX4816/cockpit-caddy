import { useState } from "react";
import {
  Checkbox,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ResettableTextInput, SectionShell } from "./sectionLayout";
import { SizeField } from "./SizeField";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface ServerTimeoutValues {
  readTimeout: string;
  readHeaderTimeout: string;
  writeTimeout: string;
  idleTimeout: string;
  maxHeaderBytes: string;
  /** Explicitly restrict to HTTP/1.1 + HTTP/2, opting out of Caddy's default HTTP/3 (#51). */
  disableHttp3: boolean;
  /** TCP keep-alive probe interval and idle time before the first probe (#328). */
  keepaliveInterval: string;
  keepaliveIdle: string;
  strictSniHost: boolean;
  logCredentials: boolean;
  enableFullDuplex: boolean;
}

/** The #328 fields of the form, from a stored ServerExtras. */
export function serverExtrasToValues(e: import("../api/types").ServerExtras | undefined): Pick<ServerTimeoutValues, "keepaliveInterval" | "keepaliveIdle" | "strictSniHost" | "logCredentials" | "enableFullDuplex"> {
  return {
    keepaliveInterval: e?.keepaliveInterval ?? "",
    keepaliveIdle: e?.keepaliveIdle ?? "",
    strictSniHost: e?.strictSniHost ?? false,
    logCredentials: e?.logCredentials ?? false,
    enableFullDuplex: e?.enableFullDuplex ?? false,
  };
}

/** The stored ServerExtras for the form's #328 fields; undefined when none is set. */
export function serverExtrasFromValues(v: ServerTimeoutValues): import("../api/types").ServerExtras | undefined {
  const e: import("../api/types").ServerExtras = {
    keepaliveInterval: v.keepaliveInterval.trim() || undefined,
    keepaliveIdle: v.keepaliveIdle.trim() || undefined,
    strictSniHost: v.strictSniHost || undefined,
    logCredentials: v.logCredentials || undefined,
    enableFullDuplex: v.enableFullDuplex || undefined,
  };
  for (const k of Object.keys(e) as Array<keyof typeof e>) if (e[k] == null) delete e[k];
  return Object.keys(e).length ? e : undefined;
}

// Empty means Caddy's own default (#249): no read_body or write timeout, read_header 1m,
// idle 5m, 16 KiB of headers. "Defaults" therefore clears the fields; the placeholders show
// what Caddy uses for each. Values like read 5s / write 10s cut off uploads and downloads.
export const TIMEOUTS_EMPTY: ServerTimeoutValues = {
  readTimeout: "",
  readHeaderTimeout: "",
  writeTimeout: "",
  idleTimeout: "",
  maxHeaderBytes: "",
  disableHttp3: false,
  ...serverExtrasToValues(undefined),
};

interface Props {
  value: ServerTimeoutValues;
  onChange: (v: ServerTimeoutValues) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function ServerTimeoutsSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const hasValues = !!(value.readTimeout || value.readHeaderTimeout || value.writeTimeout || value.idleTimeout || value.maxHeaderBytes || value.disableHttp3 || value.keepaliveInterval || value.keepaliveIdle || value.strictSniHost || value.logCredentials || value.enableFullDuplex);
  const [internalExpanded, setInternalExpanded] = useState(hasValues);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function set(key: keyof ServerTimeoutValues, v: string) {
    onChange({ ...value, [key]: v });
  }
  function setBool(key: keyof ServerTimeoutValues, v: boolean) {
    onChange({ ...value, [key]: v });
  }

  return (
    <SectionShell
      heading={t("server_timeouts.heading")}
      toggleContent={<>{t("server_timeouts.section_title")}{hasValues && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => onChange(TIMEOUTS_EMPTY)}
        onDefaults={() => onChange(TIMEOUTS_EMPTY)}
        isDisabled={isDisabled}
      />
      <HelperText style={{ marginBottom: "0.6rem" }}>
        <HelperTextItem>{t("server_timeouts.defaults_help")}</HelperTextItem>
      </HelperText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        <FormGroup label={t("server_timeouts.read_timeout")} fieldId="st-read" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="st-read"
            value={value.readTimeout}
            onChange={(_e, v) => set("readTimeout", v)}
            placeholder={t("server_timeouts.no_timeout")}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.read_header_timeout")} fieldId="st-read-header" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="st-read-header"
            value={value.readHeaderTimeout}
            onChange={(_e, v) => set("readHeaderTimeout", v)}
            placeholder={t("common.default_value", { value: "1m" })}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.write_timeout")} fieldId="st-write" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="st-write"
            value={value.writeTimeout}
            onChange={(_e, v) => set("writeTimeout", v)}
            placeholder={t("server_timeouts.no_timeout")}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.idle_timeout")} fieldId="st-idle" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="st-idle"
            value={value.idleTimeout}
            onChange={(_e, v) => set("idleTimeout", v)}
            placeholder={t("common.default_value", { value: "5m" })}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.max_header_bytes")} fieldId="st-max-header" style={{ flex: "1 1 10rem" }}>
          <SizeField
            id="st-max-header"
            value={value.maxHeaderBytes}
            onChange={v => set("maxHeaderBytes", v)}
            defaultBytes={16384}
            emptyUnit="KB"
            isDisabled={isDisabled}
          />
          <FormHelperText>
            <HelperText>
              <HelperTextItem>{t("server_timeouts.max_header_bytes_help")}</HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginTop: "0.6rem" }}>
        <FormGroup label={t("server_timeouts.keepalive_interval")} fieldId="st-keepalive-interval" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="st-keepalive-interval"
            value={value.keepaliveInterval}
            onChange={(_e, v) => set("keepaliveInterval", v)}
            placeholder={t("common.default_value", { value: "15s" })}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.keepalive_idle")} fieldId="st-keepalive-idle" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="st-keepalive-idle"
            value={value.keepaliveIdle}
            onChange={(_e, v) => set("keepaliveIdle", v)}
            placeholder={t("common.default_value", { value: "15s" })}
            isDisabled={isDisabled}
          />
        </FormGroup>
      </div>
      <FormGroup label={t("server_timeouts.options_label")} fieldId="st-strict-sni" style={{ marginTop: "0.6rem" }}>
        <Checkbox
          id="st-strict-sni"
          label={t("server_timeouts.strict_sni_host")}
          description={t("server_timeouts.strict_sni_host_help")}
          isChecked={value.strictSniHost}
          onChange={(_e, checked) => setBool("strictSniHost", checked)}
          isDisabled={isDisabled}
        />
        <Checkbox
          id="st-log-credentials"
          label={t("server_timeouts.log_credentials")}
          description={t("server_timeouts.log_credentials_help")}
          isChecked={value.logCredentials}
          onChange={(_e, checked) => setBool("logCredentials", checked)}
          isDisabled={isDisabled}
        />
        <Checkbox
          id="st-full-duplex"
          label={t("server_timeouts.enable_full_duplex")}
          description={t("server_timeouts.enable_full_duplex_help")}
          isChecked={value.enableFullDuplex}
          onChange={(_e, checked) => setBool("enableFullDuplex", checked)}
          isDisabled={isDisabled}
        />
      </FormGroup>
      <FormGroup label={t("server_timeouts.http3_label")} fieldId="st-disable-http3" style={{ marginTop: "0.6rem" }}>
        <Checkbox
          id="st-disable-http3"
          label={t("server_timeouts.http3_checkbox")}
          isChecked={value.disableHttp3}
          onChange={(_e, checked) => setBool("disableHttp3", checked)}
          isDisabled={isDisabled}
        />
        <FormHelperText>
          <HelperText>
            <HelperTextItem>{t("server_timeouts.http3_help")}</HelperTextItem>
          </HelperText>
        </FormHelperText>
      </FormGroup>
    </SectionShell>
  );
}
