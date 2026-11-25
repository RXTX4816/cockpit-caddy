import { FormGroup, FormHelperText, HelperText, HelperTextItem } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ResettableTextInput } from "./sectionLayout";
import { isIpAddress } from "../api/caddyfileDocument";

/** The bind field of #323, as typed: addresses separated by spaces or commas. */
export function bindToValue(bind: string[] | undefined): string {
  return bind?.join(" ") ?? "";
}

export function bindFromValue(v: string): string[] | undefined {
  const list = v.split(/[\s,]+/).filter(Boolean);
  return list.length ? [...new Set(list)] : undefined;
}

/** An address that is neither an IP nor a host name (an entry with a port, a scheme or a slash). */
export function bindHasErrors(v: string): boolean {
  return (bindFromValue(v) ?? []).some(a => !(isIpAddress(a) || /^[A-Za-z0-9.-]+$/.test(a) || /^\[?[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*\]?$/.test(a)));
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  isDisabled?: boolean;
  idPrefix?: string;
}

/** Which addresses the site listens on, next to its host name (#323). */
export function BindSection({ value, onChange, isDisabled, idPrefix = "" }: Props) {
  const { t } = useTranslation();
  const err = bindHasErrors(value);
  return (
    <FormGroup label={t("bind.label")} fieldId={`${idPrefix}bind`} style={{ marginTop: "0.6rem" }}>
      <ResettableTextInput
        id={`${idPrefix}bind`}
        value={value}
        onChange={(_e, v) => onChange(v)}
        placeholder="127.0.0.1 ::1"
        validated={err ? "error" : "default"}
        isDisabled={isDisabled}
      />
      <FormHelperText>
        <HelperText><HelperTextItem variant={err ? "error" : "default"}>{err ? t("bind.invalid") : t("bind.help")}</HelperTextItem></HelperText>
      </FormHelperText>
    </FormGroup>
  );
}
