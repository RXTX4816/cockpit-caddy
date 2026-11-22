import { useState } from "react";
import { FormSelect, FormSelectOption } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ResettableTextInput } from "./sectionLayout";

export type SizeUnit = "B" | "KB" | "MB" | "GB";
const FACTOR: Record<SizeUnit, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const UNITS: SizeUnit[] = ["B", "KB", "MB", "GB"];

/** A byte count as the largest unit it divides into evenly: "10485760" → 10 MB. */
export function bytesToSize(bytes: string): { amount: string; unit: SizeUnit } {
  const n = Number(bytes);
  if (!bytes.trim() || !Number.isFinite(n) || n <= 0) return { amount: bytes.trim(), unit: "MB" };
  const unit = [...UNITS].reverse().find(u => n % FACTOR[u] === 0) ?? "B";
  return { amount: String(n / FACTOR[unit]), unit };
}

/** "512" KB → "524288". Empty stays empty (Caddy's default); a bad number is passed through. */
export function sizeToBytes(amount: string, unit: SizeUnit): string {
  const a = amount.trim();
  if (!a) return "";
  const n = Number(a);
  return Number.isFinite(n) ? String(Math.round(n * FACTOR[unit])) : a;
}

interface Props {
  id: string;
  /** Bytes, as a string; empty means Caddy's default. */
  value: string;
  onChange: (bytes: string) => void;
  isDisabled?: boolean;
  /** Caddy's default in bytes, shown as "Default: 16 KB" while the field is empty. */
  defaultBytes?: number;
  /** The unit shown while the field is empty (default MB). */
  emptyUnit?: SizeUnit;
}

/** A size as number + unit (#260), stored as bytes. */
export function SizeField({ id, value, onChange, isDisabled, defaultBytes, emptyUnit = "MB" }: Props) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<SizeUnit>(() => (value ? bytesToSize(value).unit : emptyUnit));
  // The amount is derived from the stored bytes in the chosen unit, so an outside reset shows up.
  // A byte count that isn't a whole multiple of the unit shows as a fraction (1536 in KB → 1.5).
  const shown = value && Number.isFinite(Number(value)) ? String(Number(value) / FACTOR[unit]) : value;
  const [draft, setDraft] = useState<string | null>(null);
  const amount = draft ?? (value ? shown : "");
  // The default names its own unit ("Default: 16 KB"), so it reads right whatever unit is selected.
  const def = defaultBytes === undefined ? undefined : bytesToSize(String(defaultBytes));
  const placeholder = def && t("common.default_value", { value: `${def.amount} ${t(`common.unit_${def.unit.toLowerCase()}`)}` });

  return (
    <span style={{ display: "flex", gap: "0.25rem", alignItems: "center", maxWidth: "20rem" }}>
      <ResettableTextInput
        id={id}
        type="number"
        min={0}
        value={amount}
        placeholder={placeholder}
        onChange={(_e, v) => { setDraft(v); onChange(sizeToBytes(v, unit)); }}
        onBlur={() => setDraft(null)}
        isDisabled={isDisabled}
        style={{ flex: "1 1 6rem" }}
      />
      <FormSelect
        id={`${id}-unit`}
        aria-label={t("common.size_unit")}
        value={unit}
        onChange={(_e, v) => { const u = v as SizeUnit; setUnit(u); if (amount) onChange(sizeToBytes(amount, u)); }}
        isDisabled={isDisabled}
        style={{ width: "6rem" }}
      >
        {UNITS.map(u => <FormSelectOption key={u} value={u} label={t(`common.unit_${u.toLowerCase()}`)} />)}
      </FormSelect>
    </span>
  );
}

