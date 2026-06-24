import { useState } from "react";
import {
  ExpandableSection,
  FormGroup,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";

export interface TransportValues {
  dialTimeout: string;
  responseHeaderTimeout: string;
}

interface Props {
  value: TransportValues;
  onChange: (v: TransportValues) => void;
  isDisabled?: boolean;
}

export function TransportSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const hasValues = !!(value.dialTimeout || value.responseHeaderTimeout);
  const [expanded, setExpanded] = useState(hasValues);

  function set(key: keyof TransportValues, v: string) {
    onChange({ ...value, [key]: v });
  }

  return (
    <ExpandableSection
      toggleText={t("transport.section_title")}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", paddingTop: "0.25rem" }}>
        <FormGroup label={t("transport.dial_timeout")} fieldId="transport-dial" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="transport-dial"
            value={value.dialTimeout}
            onChange={(_e, v) => set("dialTimeout", v)}
            placeholder="10s"
            isDisabled={isDisabled}
          />
        </FormGroup>
        <FormGroup label={t("transport.response_header_timeout")} fieldId="transport-resp" style={{ flex: "1 1 10rem" }}>
          <TextInput
            id="transport-resp"
            value={value.responseHeaderTimeout}
            onChange={(_e, v) => set("responseHeaderTimeout", v)}
            placeholder="30s"
            isDisabled={isDisabled}
          />
        </FormGroup>

      </div>
    </ExpandableSection>
  );
}
