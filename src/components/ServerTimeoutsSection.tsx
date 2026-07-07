import { useState } from "react";
import {
  Checkbox,
  ExpandableSection,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
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
}

const TIMEOUTS_DEFAULTS: ServerTimeoutValues = {
  readTimeout: "5s",
  readHeaderTimeout: "2s",
  writeTimeout: "10s",
  idleTimeout: "5m",
  maxHeaderBytes: "1048576",
  disableHttp3: false,
};
const TIMEOUTS_EMPTY: ServerTimeoutValues = {
  readTimeout: "",
  readHeaderTimeout: "",
  writeTimeout: "",
  idleTimeout: "",
  maxHeaderBytes: "",
  disableHttp3: false,
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
  const hasValues = !!(value.readTimeout || value.readHeaderTimeout || value.writeTimeout || value.idleTimeout || value.maxHeaderBytes || value.disableHttp3);
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
    <ExpandableSection
      toggleContent={<>{t("server_timeouts.section_title")}{hasValues && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => onChange(TIMEOUTS_EMPTY)}
        onDefaults={() => onChange(TIMEOUTS_DEFAULTS)}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        <FormGroup label={t("server_timeouts.read_timeout")} fieldId="st-read" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="st-read"
            value={value.readTimeout}
            onChange={(_e, v) => set("readTimeout", v)}
            placeholder="5s"
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.read_header_timeout")} fieldId="st-read-header" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="st-read-header"
            value={value.readHeaderTimeout}
            onChange={(_e, v) => set("readHeaderTimeout", v)}
            placeholder="2s"
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.write_timeout")} fieldId="st-write" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="st-write"
            value={value.writeTimeout}
            onChange={(_e, v) => set("writeTimeout", v)}
            placeholder="10s"
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.idle_timeout")} fieldId="st-idle" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="st-idle"
            value={value.idleTimeout}
            onChange={(_e, v) => set("idleTimeout", v)}
            placeholder="5m"
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("server_timeouts.max_header_bytes")} fieldId="st-max-header" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="st-max-header"
            type="number"
            value={value.maxHeaderBytes}
            onChange={(_e, v) => set("maxHeaderBytes", v)}
            placeholder="1048576"
            isDisabled={isDisabled}
          />
          <FormHelperText>
            <HelperText>
              <HelperTextItem>{t("server_timeouts.max_header_bytes_help")}</HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>
      </div>
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
    </ExpandableSection>
  );
}
