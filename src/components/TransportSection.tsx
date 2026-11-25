import { useState } from "react";
import {
  FormGroup,
  HelperText,
  HelperTextItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ResettableTextInput, SectionShell } from "./sectionLayout";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface TransportValues {
  dialTimeout: string;
  responseHeaderTimeout: string;
  /** reverse_proxy streaming options (#325). */
  flushInterval: string;
  streamTimeout: string;
  streamCloseDelay: string;
  /** Transport options (#327): numbers and the version list are kept as text while typed. */
  tlsServerName: string;
  keepalive: string;
  keepaliveIdleConns: string;
  keepaliveIdleConnsPerHost: string;
  httpVersions: string;
  readTimeout: string;
  writeTimeout: string;
}

// Empty means Caddy's own default (#249): dial 3s, no response header timeout. "Defaults"
// clears the fields; the placeholders show Caddy's values.
export const TRANSPORT_EMPTY: TransportValues = { dialTimeout: "", responseHeaderTimeout: "", flushInterval: "", streamTimeout: "", streamCloseDelay: "",
  tlsServerName: "", keepalive: "", keepaliveIdleConns: "", keepaliveIdleConnsPerHost: "", httpVersions: "", readTimeout: "", writeTimeout: "",
};

interface Props {
  value: TransportValues;
  onChange: (v: TransportValues) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function TransportSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const hasValues = Object.values(value).some(Boolean);
  const [internalExpanded, setInternalExpanded] = useState(hasValues);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function set(key: keyof TransportValues, v: string) {
    onChange({ ...value, [key]: v });
  }

  function textField(key: keyof TransportValues, id: string, label: string, placeholder: string, type?: "number") {
    return (
      <FormGroup label={label} fieldId={id} style={{ flex: "1 1 10rem" }}>
        <ResettableTextInput id={id} type={type} value={value[key]} onChange={(_e, v) => set(key, v)} placeholder={placeholder} isDisabled={isDisabled} />
      </FormGroup>
    );
  }

  return (
    <SectionShell
      heading={t("transport.heading")}
      toggleContent={<>{t("transport.section_title")}{hasValues && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => onChange(TRANSPORT_EMPTY)}
        onDefaults={() => onChange(TRANSPORT_EMPTY)}
        isDisabled={isDisabled}
      />
      <HelperText style={{ marginBottom: "0.6rem" }}>
        <HelperTextItem>{t("transport.defaults_help")}</HelperTextItem>
      </HelperText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        <FormGroup label={t("transport.dial_timeout")} fieldId="transport-dial" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="transport-dial"
            value={value.dialTimeout}
            onChange={(_e, v) => set("dialTimeout", v)}
            placeholder={t("common.default_value", { value: "3s" })}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("transport.response_header_timeout")} fieldId="transport-resp" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="transport-resp"
            value={value.responseHeaderTimeout}
            onChange={(_e, v) => set("responseHeaderTimeout", v)}
            placeholder={t("server_timeouts.no_timeout")}
            isDisabled={isDisabled}
          />
        </FormGroup>
      </div>
      <HelperText style={{ margin: "0.8rem 0 0.4rem" }}>
        <HelperTextItem>{t("transport.streaming_help")}</HelperTextItem>
      </HelperText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        <FormGroup label={t("transport.flush_interval")} fieldId="transport-flush" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="transport-flush"
            value={value.flushInterval}
            onChange={(_e, v) => set("flushInterval", v)}
            placeholder={t("transport.flush_interval_placeholder")}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("transport.stream_timeout")} fieldId="transport-stream-timeout" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="transport-stream-timeout"
            value={value.streamTimeout}
            onChange={(_e, v) => set("streamTimeout", v)}
            placeholder={t("server_timeouts.no_timeout")}
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("transport.stream_close_delay")} fieldId="transport-stream-close" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="transport-stream-close"
            value={value.streamCloseDelay}
            onChange={(_e, v) => set("streamCloseDelay", v)}
            placeholder={t("server_timeouts.no_timeout")}
            isDisabled={isDisabled}
          />
        </FormGroup>
      </div>
      <div style={{ margin: "1rem 0 0.4rem", fontWeight: 600 }}>{t("transport.connection_title")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        {textField("tlsServerName", "transport-tls-name", t("transport.tls_server_name"), t("common.example_value", { value: "backend.internal" }))}
        {textField("httpVersions", "transport-versions", t("transport.versions"), t("common.example_value", { value: "h2c 2" }))}
        {textField("readTimeout", "transport-read", t("transport.read_timeout"), t("server_timeouts.no_timeout"))}
        {textField("writeTimeout", "transport-write", t("transport.write_timeout"), t("server_timeouts.no_timeout"))}
        {textField("keepalive", "transport-keepalive", t("transport.keepalive"), t("common.example_value", { value: "off" }))}
        {textField("keepaliveIdleConns", "transport-idle-conns", t("transport.keepalive_idle_conns"), t("common.default_value", { value: "0" }), "number")}
        {textField("keepaliveIdleConnsPerHost", "transport-idle-conns-host", t("transport.keepalive_idle_conns_per_host"), t("common.default_value", { value: "32" }), "number")}
      </div>
    </SectionShell>
  );
}
