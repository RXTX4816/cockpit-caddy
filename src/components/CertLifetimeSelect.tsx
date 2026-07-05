import { FormSelect, FormSelectOption } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";

const CUSTOM = "__custom__";

const PRESETS: Array<{ value: string; labelKey: string }> = [
  { value: "", labelKey: "tls_policy.lifetime_preset_default" },
  { value: "90d", labelKey: "tls_policy.lifetime_preset_90d" },
  { value: "180d", labelKey: "tls_policy.lifetime_preset_180d" },
  { value: "365d", labelKey: "tls_policy.lifetime_preset_1y" },
];

interface Props {
  /** Current certLifetime value (empty string = Caddy's own default, 12h). */
  value: string;
  onChange: (v: string) => void;
  isDisabled?: boolean;
}

/**
 * Quick-pick dropdown for common internal-issuer certificate lifetimes, shown
 * next to the TLS toggle. Selecting a preset writes straight into the same
 * value the TLS Policy section's lifetime text field uses, so both stay in
 * sync. If the current value doesn't match a preset (a custom duration was
 * typed below), shows a disabled "Custom" entry reflecting that instead of
 * silently snapping to one of the presets.
 */
export function CertLifetimeSelect({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const isCustom = !PRESETS.some(p => p.value === value);

  return (
    <FormSelect
      id="cert-lifetime-preset"
      value={isCustom ? CUSTOM : value}
      onChange={(_e, v) => { if (v !== CUSTOM) onChange(v); }}
      isDisabled={isDisabled}
      style={{ maxWidth: "14rem" }}
    >
      {PRESETS.map(p => (
        <FormSelectOption key={p.value || "default"} value={p.value} label={t(p.labelKey)} />
      ))}
      {isCustom && (
        <FormSelectOption value={CUSTOM} label={`${t("tls_policy.lifetime_preset_custom")} (${value})`} isDisabled />
      )}
    </FormSelect>
  );
}
