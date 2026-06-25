import { useState } from "react";
import {
  Button,
  ExpandableSection,
  FormGroup,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { hashPassword } from "../api";
import { SectionActions } from "./SectionActions";

export interface AuthEntry {
  username: string;
  password: string;
  existingHash?: string;
}

export async function resolveBasicAuth(entries: AuthEntry[]): Promise<{ username: string; passwordHash: string }[]> {
  return Promise.all(
    entries
      .filter(e => e.username.trim())
      .map(async e => {
        const hash = e.password.trim()
          ? await hashPassword(e.password.trim())
          : (e.existingHash ?? "");
        return { username: e.username.trim(), passwordHash: hash };
      }),
  );
}

interface Props {
  value: AuthEntry[];
  onChange: (v: AuthEntry[]) => void;
  isDisabled?: boolean;
}

export function BasicAuthSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(value.length > 0);

  function update(idx: number, patch: Partial<AuthEntry>) {
    onChange(value.map((e, i) => i === idx ? { ...e, ...patch } : e));
  }

  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...value, { username: "", password: "" }]);
    setExpanded(true);
  }

  return (
    <ExpandableSection
      toggleText={t("basic_auth.section_title")}
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
            <FormGroup label={t("basic_auth.field_username")} fieldId={`auth-user-${idx}`} style={{ flex: "1 1 8rem" }}>
              <TextInput
                id={`auth-user-${idx}`}
                value={entry.username}
                onChange={(_e, v) => update(idx, { username: v })}
                placeholder="alice"
                isDisabled={isDisabled}
              />
            </FormGroup>
            <FormGroup label={t("basic_auth.field_password")} fieldId={`auth-pass-${idx}`} style={{ flex: "1 1 10rem" }}>
              <TextInput
                id={`auth-pass-${idx}`}
                type="password"
                value={entry.password}
                onChange={(_e, v) => update(idx, { password: v })}
                placeholder={entry.existingHash ? t("basic_auth.field_password_keep") : ""}
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
            + {t("basic_auth.add_button")}
          </Button>
        </div>
      </div>
    </ExpandableSection>
  );
}
