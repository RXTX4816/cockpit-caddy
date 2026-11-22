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
}

// Empty means Caddy's own default (#249): dial 3s, no response header timeout. "Defaults"
// clears the fields; the placeholders show Caddy's values.
const TRANSPORT_EMPTY: TransportValues = { dialTimeout: "", responseHeaderTimeout: "" };

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
  const hasValues = !!(value.dialTimeout || value.responseHeaderTimeout);
  const [internalExpanded, setInternalExpanded] = useState(hasValues);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function set(key: keyof TransportValues, v: string) {
    onChange({ ...value, [key]: v });
  }

  return (
    <SectionShell
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
    </SectionShell>
  );
}
