import { useState } from "react";
import {
  Button,
  FormGroup,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { SectionShell } from "./sectionLayout";
import { hashPassword } from "../api";
import type { BasicAuthOptions } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface AuthEntry {
  username: string;
  password: string;
  existingHash?: string;
}

/** The realm and algorithm fields of the form (#337); empty is Caddy's default. */
export interface BasicAuthOptionValues {
  realm: string;
  algorithm: "" | "bcrypt" | "argon2id";
}

export const BASIC_AUTH_OPTIONS_EMPTY: BasicAuthOptionValues = { realm: "", algorithm: "" };

export function basicAuthOptionsToValues(o: BasicAuthOptions | undefined): BasicAuthOptionValues {
  return { realm: o?.realm ?? "", algorithm: o?.algorithm ?? "" };
}

export function basicAuthOptionsFromValues(v: BasicAuthOptionValues): BasicAuthOptions | undefined {
  const o: BasicAuthOptions = { realm: v.realm.trim() || undefined, algorithm: v.algorithm || undefined };
  for (const k of Object.keys(o) as Array<keyof BasicAuthOptions>) if (o[k] == null) delete o[k];
  return Object.keys(o).length ? o : undefined;
}

/** Which algorithm a stored hash was made with; anything but argon2id is read as bcrypt. */
function hashAlgorithm(hash: string): "bcrypt" | "argon2id" {
  return hash.startsWith("$argon2id$") ? "argon2id" : "bcrypt";
}

/**
 * Caddy checks every password with the one algorithm of the block, so a kept hash made with
 * another one would lock its user out. Those users have to enter their password again.
 */
export function basicAuthHashMismatch(entries: AuthEntry[], algorithm: "" | "bcrypt" | "argon2id"): boolean {
  const want = algorithm || "bcrypt";
  return entries.some(e => e.username.trim() && !e.password.trim() && e.existingHash && hashAlgorithm(e.existingHash) !== want);
}

export async function resolveBasicAuth(entries: AuthEntry[], algorithm: "" | "bcrypt" | "argon2id" = ""): Promise<{ username: string; passwordHash: string }[]> {
  return Promise.all(
    entries
      .filter(e => e.username.trim())
      .map(async e => {
        const hash = e.password.trim()
          ? await hashPassword(e.password.trim(), algorithm || undefined)
          : (e.existingHash ?? "");
        return { username: e.username.trim(), passwordHash: hash };
      }),
  );
}

interface Props {
  value: AuthEntry[];
  onChange: (v: AuthEntry[]) => void;
  options?: BasicAuthOptionValues;
  onOptionsChange?: (v: BasicAuthOptionValues) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function BasicAuthSection({ value, onChange, options = BASIC_AUTH_OPTIONS_EMPTY, onOptionsChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(value.length > 0);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

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
    <SectionShell
      heading={t("basic_auth.heading")}
      toggleContent={<>{t("basic_auth.section_title")}{value.length > 0 && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => { onChange([]); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      {onOptionsChange && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginBottom: "0.75rem" }}>
          <FormGroup label={t("basic_auth.realm")} fieldId="auth-realm" style={{ flex: "1 1 12rem" }}>
            <TextInput
              id="auth-realm"
              value={options.realm}
              onChange={(_e, v) => onOptionsChange({ ...options, realm: v })}
              placeholder={t("common.default_value", { value: "restricted" })}
              isDisabled={isDisabled}
            />
          </FormGroup>
          <FormGroup label={t("basic_auth.algorithm")} fieldId="auth-algorithm" style={{ flex: "1 1 12rem" }}>
            <FormSelect
              id="auth-algorithm"
              value={options.algorithm}
              onChange={(_e, v) => onOptionsChange({ ...options, algorithm: v as BasicAuthOptionValues["algorithm"] })}
              isDisabled={isDisabled}
            >
              <FormSelectOption value="" label={t("basic_auth.algorithm_default")} />
              <FormSelectOption value="argon2id" label={t("basic_auth.algorithm_argon2id")} />
            </FormSelect>
          </FormGroup>
        </div>
      )}
      {basicAuthHashMismatch(value, options.algorithm) && (
        <HelperText style={{ marginBottom: "0.5rem" }}>
          <HelperTextItem variant="error">{t("basic_auth.algorithm_mismatch")}</HelperTextItem>
        </HelperText>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {value.map((entry, idx) => (
          <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <FormGroup label={t("basic_auth.field_username")} fieldId={`auth-user-${idx}`} style={{ flex: "1 1 8rem" }}>
              <TextInput
                id={`auth-user-${idx}`}
                value={entry.username}
                onChange={(_e, v) => update(idx, { username: v })}
                placeholder={t("common.example_value", { value: "alice" })}
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
    </SectionShell>
  );
}
