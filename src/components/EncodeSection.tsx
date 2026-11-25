import { useState } from "react";
import { FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem, TextArea } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { EncodeOptions } from "../api";
import { ResettableTextInput, SectionShell } from "./sectionLayout";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

/** The form's view of the `encode` options (#335); empty is what Caddy gets without them. */
export interface EncodeValues {
  /** "" (gzip, zstd), "zstd gzip", "gzip" or "zstd". */
  algorithms: string;
  minimumLength: string;
  /** Space-separated status codes or classes such as `2xx 404`. */
  matchStatus: string;
  /** One `Name value` per line. */
  matchHeaders: string;
}

export const ENCODE_EMPTY: EncodeValues = { algorithms: "", minimumLength: "", matchStatus: "", matchHeaders: "" };

const ALGORITHM_CHOICES = ["", "zstd gzip", "gzip", "zstd"];

export function encodeToValues(o: EncodeOptions | undefined): EncodeValues {
  return {
    algorithms: o?.algorithms?.join(" ") ?? "",
    minimumLength: o?.minimumLength != null ? String(o.minimumLength) : "",
    matchStatus: o?.matchStatus?.join(" ") ?? "",
    matchHeaders: (o?.matchHeaders ?? []).map(h => `${h.name} ${h.value}`).join("\n"),
  };
}

export function encodeFromValues(v: EncodeValues): EncodeOptions | undefined {
  const headers = v.matchHeaders.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const [name, ...rest] = l.split(/\s+/);
    return { name, value: rest.join(" ") };
  }).filter(h => h.value);
  const n = parseInt(v.minimumLength, 10);
  const o: EncodeOptions = {
    algorithms: v.algorithms ? (v.algorithms.split(" ") as EncodeOptions["algorithms"]) : undefined,
    minimumLength: v.minimumLength.trim() && !isNaN(n) && n >= 0 ? n : undefined,
    matchStatus: v.matchStatus.trim() ? v.matchStatus.trim().split(/\s+/) : undefined,
    matchHeaders: headers.length ? headers : undefined,
  };
  for (const k of Object.keys(o) as Array<keyof EncodeOptions>) if (o[k] == null) delete o[k];
  return Object.keys(o).length ? o : undefined;
}

/** A line without a value, or a status that is neither a code nor a class like 2xx. */
export function validateEncode(v: EncodeValues): boolean {
  if (v.minimumLength.trim() && !/^\d+$/.test(v.minimumLength.trim())) return true;
  if (v.matchStatus.trim() && !v.matchStatus.trim().split(/\s+/).every(s => /^([1-5]\d\d|[1-5]xx)$/.test(s))) return true;
  return v.matchHeaders.split("\n").map(l => l.trim()).filter(Boolean).some(l => l.split(/\s+/).length < 2);
}

interface Props {
  value: EncodeValues;
  onChange: (v: EncodeValues) => void;
  isDisabled?: boolean;
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function EncodeSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const hasValues = !!(value.algorithms || value.minimumLength || value.matchStatus || value.matchHeaders);
  const [internalExpanded, setInternalExpanded] = useState(hasValues);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;
  const set = <K extends keyof EncodeValues>(key: K, v: string) => onChange({ ...value, [key]: v });
  const lengthErr = !!value.minimumLength.trim() && !/^\d+$/.test(value.minimumLength.trim());
  const statusErr = !!value.matchStatus.trim() && !value.matchStatus.trim().split(/\s+/).every(s => /^([1-5]\d\d|[1-5]xx)$/.test(s));
  const headersErr = value.matchHeaders.split("\n").map(l => l.trim()).filter(Boolean).some(l => l.split(/\s+/).length < 2);

  return (
    <SectionShell
      heading={t("encode.heading")}
      toggleContent={<>{t("encode.section_title")}{hasValues && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions onClear={() => onChange(ENCODE_EMPTY)} onDefaults={() => onChange(ENCODE_EMPTY)} isDisabled={isDisabled} />
      <HelperText style={{ marginBottom: "0.6rem" }}>
        <HelperTextItem>{t("encode.help")}</HelperTextItem>
      </HelperText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        <FormGroup label={t("encode.algorithms")} fieldId="encode-algorithms" style={{ flex: "1 1 14rem" }}>
          <FormSelect id="encode-algorithms" value={value.algorithms} onChange={(_e, v) => set("algorithms", v)} isDisabled={isDisabled}>
            {ALGORITHM_CHOICES.map(a => (
              <FormSelectOption key={a || "default"} value={a} label={t(`encode.algorithms_${a ? a.replace(" ", "_") : "default"}`)} />
            ))}
          </FormSelect>
        </FormGroup>
        <FormGroup label={t("encode.minimum_length")} fieldId="encode-minimum-length" style={{ flex: "1 1 10rem" }}>
          <ResettableTextInput
            id="encode-minimum-length"
            value={value.minimumLength}
            onChange={(_e, v) => set("minimumLength", v)}
            placeholder={t("common.default_value", { value: "512" })}
            validated={lengthErr ? "error" : "default"}
            isDisabled={isDisabled}
          />
          <FormHelperText>
            <HelperText><HelperTextItem variant={lengthErr ? "error" : "default"}>{lengthErr ? t("encode.invalid_number") : t("encode.minimum_length_help")}</HelperTextItem></HelperText>
          </FormHelperText>
        </FormGroup>
      </div>
      <FormGroup label={t("encode.match_status")} fieldId="encode-match-status" style={{ marginTop: "0.6rem" }}>
        <ResettableTextInput
          id="encode-match-status"
          value={value.matchStatus}
          onChange={(_e, v) => set("matchStatus", v)}
          placeholder="2xx 404"
          validated={statusErr ? "error" : "default"}
          isDisabled={isDisabled}
        />
        <FormHelperText>
          <HelperText><HelperTextItem variant={statusErr ? "error" : "default"}>{statusErr ? t("encode.invalid_status") : t("encode.match_status_help")}</HelperTextItem></HelperText>
        </FormHelperText>
      </FormGroup>
      <FormGroup label={t("encode.match_headers")} fieldId="encode-match-headers" style={{ marginTop: "0.6rem" }}>
        <TextArea
          id="encode-match-headers"
          value={value.matchHeaders}
          onChange={(_e, v) => set("matchHeaders", v)}
          placeholder="Content-Type text/*"
          rows={3}
          validated={headersErr ? "error" : "default"}
          isDisabled={isDisabled}
        />
        <FormHelperText>
          <HelperText><HelperTextItem variant={headersErr ? "error" : "default"}>{headersErr ? t("encode.invalid_header") : t("encode.match_headers_help")}</HelperTextItem></HelperText>
        </FormHelperText>
      </FormGroup>
    </SectionShell>
  );
}
