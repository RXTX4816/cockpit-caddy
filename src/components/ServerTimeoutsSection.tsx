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
import { SectionActions } from "./SectionActions";

export interface ServerTimeoutValues {
  readTimeout: string;
  readHeaderTimeout: string;
  writeTimeout: string;
  idleTimeout: string;
  maxHeaderBytes: string;
}

const TIMEOUTS_DEFAULTS: ServerTimeoutValues = {
  readTimeout: "5s",
  readHeaderTimeout: "2s",
  writeTimeout: "10s",
  idleTimeout: "5m",
  maxHeaderBytes: "1048576",
};
const TIMEOUTS_EMPTY: ServerTimeoutValues = {
  readTimeout: "",
  readHeaderTimeout: "",
  writeTimeout: "",
  idleTimeout: "",
  maxHeaderBytes: "",
};

interface Props {
  value: ServerTimeoutValues;
  onChange: (v: ServerTimeoutValues) => void;
  isDisabled?: boolean;
}

export function ServerTimeoutsSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const hasValues = !!(value.readTimeout || value.readHeaderTimeout || value.writeTimeout || value.idleTimeout || value.maxHeaderBytes);
  const [expanded, setExpanded] = useState(hasValues);

  function set(key: keyof ServerTimeoutValues, v: string) {
    onChange({ ...value, [key]: v });
  }

  return (
    <ExpandableSection
      toggleText={t("server_timeouts.section_title")}
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
    </ExpandableSection>
  );
}
