import { useState } from "react";
import {
  Button,
  ExpandableSection,
  FormGroup,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface EnvEntry {
  key: string;
  value: string;
}

export function envEntriesToRecord(entries: EnvEntry[]): Record<string, string> | undefined {
  const filtered = entries.filter(e => e.key.trim());
  if (!filtered.length) return undefined;
  const record: Record<string, string> = {};
  for (const e of filtered) record[e.key.trim()] = e.value;
  return record;
}

export function envRecordToEntries(env: Record<string, string> | undefined): EnvEntry[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));
}

interface Props {
  value: EnvEntry[];
  onChange: (v: EnvEntry[]) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function PhpFastcgiEnvSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(value.length > 0);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function update(idx: number, patch: Partial<EnvEntry>) {
    onChange(value.map((e, i) => i === idx ? { ...e, ...patch } : e));
  }

  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...value, { key: "", value: "" }]);
    setExpanded(true);
  }

  return (
    <ExpandableSection
      toggleContent={<>{t("php_fastcgi.env_section_title")}{value.length > 0 && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => { onChange([]); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {value.map((entry, idx) => (
          <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <FormGroup label={t("php_fastcgi.env_field_key")} fieldId={`php-env-key-${idx}`} style={{ flex: "1 1 8rem" }}>
              <TextInput
                id={`php-env-key-${idx}`}
                value={entry.key}
                onChange={(_e, v) => update(idx, { key: v })}
                placeholder="APP_ENV"
                isDisabled={isDisabled}
              />
            </FormGroup>
            <FormGroup label={t("php_fastcgi.env_field_value")} fieldId={`php-env-value-${idx}`} style={{ flex: "1 1 10rem" }}>
              <TextInput
                id={`php-env-value-${idx}`}
                value={entry.value}
                onChange={(_e, v) => update(idx, { value: v })}
                placeholder="production"
                isDisabled={isDisabled}
              />
            </FormGroup>
            <Button
              variant="plain"
              onClick={() => remove(idx)}
              isDisabled={isDisabled}
              aria-label={t("basic_auth.remove_button")}
              style={{ marginBottom: "1px" }}
            >✕</Button>
          </div>
        ))}
        <div>
          <Button variant="link" isInline onClick={add} isDisabled={isDisabled}>
            + {t("php_fastcgi.env_add_button")}
          </Button>
        </div>
      </div>
    </ExpandableSection>
  );
}
