import { useRef, useState, useEffect } from "react";
import {
  Button,
  Checkbox,
  HelperText,
  HelperTextItem,
  Label,
  TextInput,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { SectionShell } from "./sectionLayout";
import type { HeaderOperation } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

interface Props {
  value: HeaderOperation[] | undefined;
  onChange: (v: HeaderOperation[] | undefined) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

const PRESETS: Array<{ labelKey: string; op: HeaderOperation }> = [
  { labelKey: "preset_hsts",         op: { op: "set",    name: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" } },
  { labelKey: "preset_nosniff",      op: { op: "set",    name: "X-Content-Type-Options",    value: "nosniff" } },
  { labelKey: "preset_frame",        op: { op: "set",    name: "X-Frame-Options",           value: "SAMEORIGIN" } },
  { labelKey: "preset_referrer",     op: { op: "set",    name: "Referrer-Policy",           value: "strict-origin-when-cross-origin" } },
  { labelKey: "preset_remove_server",op: { op: "delete", name: "Server" } },
];

const REGEXP_META = /[\\.+*?()|[\]{}^$]/;

/**
 * A replace as added in the form. A regexp that is plain text anyway (no special characters,
 * no `$` in the replacement) is stored as plain text, which is how it reads back from Caddy.
 */
export function replaceEntry(name: string, find: string, replacement: string, regex: boolean): HeaderOperation {
  const literal = !regex || (!REGEXP_META.test(find) && !replacement.includes("$"));
  return { op: "replace", name, value: find, replacement, ...(literal ? { literal: true } : {}) };
}

export function ResponseHeadersSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const ops = value ?? [];
  const [op, setOp] = useState<HeaderOperation["op"]>("set");
  const [name, setName] = useState("");
  const [val, setVal] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState(ops.length > 0);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;
  const bottomRef = useRef<HTMLDivElement>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function handleToggleExpand(isExpanded: boolean) {
    setExpanded(isExpanded);
    if (isExpanded) scrollToBottom();
  }

  const prevLen = useRef(ops.length);
  useEffect(() => {
    if (ops.length > prevLen.current) scrollToBottom();
    prevLen.current = ops.length;
  }, [ops.length]);

  function add() {
    if (!name.trim() || (op === "replace" && !val)) return;
    const entry: HeaderOperation = op === "delete"
      ? { op, name: name.trim() }
      : op === "replace"
        ? replaceEntry(name.trim(), val, replacement, regex)
        : { op, name: name.trim(), value: val };
    onChange([...ops, entry]);
    setName("");
    setVal("");
    setReplacement("");
  }

  function addPreset(preset: HeaderOperation) {
    if (ops.some(h => h.name === preset.name && h.op === preset.op)) return;
    onChange([...ops, preset]);
  }

  function remove(idx: number) {
    const next = ops.filter((_, i) => i !== idx);
    onChange(next.length ? next : undefined);
  }

  return (
    <SectionShell
      heading={t("response_headers.heading")}
      toggleContent={<>{t("response_headers.section_title")}{ops.length > 0 && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => handleToggleExpand(v)}
    >
      <SectionActions
        onClear={() => { onChange(undefined); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>

        {ops.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {ops.map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <Label isCompact color={h.op === "delete" ? "red" : h.op === "add" ? "green" : h.op === "replace" ? "orange" : h.op === "default" ? "purple" : "blue"}>
                  {h.op.toUpperCase()}
                </Label>
                <code style={{ fontSize: "0.85rem" }}>
                  {h.name}{h.value !== undefined ? `: ${h.value}` : ""}{h.op === "replace" ? ` → ${h.replacement ?? ""}` : ""}
                </code>
                {h.op === "replace" && !h.literal && <Label isCompact variant="outline">{t("response_headers.field_regex")}</Label>}
                <Button variant="plain" size="sm" isDanger onClick={() => remove(i)} isDisabled={isDisabled} aria-label={t("common.remove_aria")}>
                  ×
                </Button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--pf-t--global--text--color--subtle)" }}>
            {t("response_headers.presets_label")}:
          </span>
          {PRESETS.map(({ labelKey, op: preset }) => (
            <Button
              key={preset.name}
              variant="secondary"
              size="sm"
              onClick={() => addPreset(preset)}
              isDisabled={isDisabled || ops.some(h => h.name === preset.name && h.op === preset.op)}
            >
              {t(`response_headers.${labelKey}`)}
            </Button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <ToggleGroup aria-label={t("common.header_op_aria")} isCompact>
            {(["set", "add", "default", "delete", "replace"] as HeaderOperation["op"][]).map(o => (
              <ToggleGroupItem
                key={o}
                text={t(`response_headers.op_${o}`)}
                buttonId={`resp-hdr-op-${o}`}
                isSelected={op === o}
                onChange={() => !isDisabled && setOp(o)}
              />
            ))}
          </ToggleGroup>
          <TextInput
            aria-label={t("response_headers.field_name")}
            value={name}
            onChange={(_e, v) => setName(v)}
            placeholder={t("response_headers.field_name")}
            isDisabled={isDisabled}
            style={{ flex: "1 1 10rem", minWidth: "8rem" }}
          />
          {op !== "delete" && (
            <TextInput
              aria-label={t(op === "replace" ? "response_headers.field_search" : "response_headers.field_value")}
              value={val}
              onChange={(_e, v) => setVal(v)}
              placeholder={t(op === "replace" ? "response_headers.field_search" : "response_headers.field_value")}
              isDisabled={isDisabled}
              style={{ flex: "2 1 12rem", minWidth: "8rem" }}
            />
          )}
          {op === "replace" && (
            <TextInput
              aria-label={t("response_headers.field_replacement")}
              value={replacement}
              onChange={(_e, v) => setReplacement(v)}
              placeholder={t("response_headers.field_replacement")}
              isDisabled={isDisabled}
              style={{ flex: "2 1 12rem", minWidth: "8rem" }}
            />
          )}
          {op === "replace" && (
            <Checkbox
              id="resp-hdr-regex"
              label={t("response_headers.field_regex")}
              isChecked={regex}
              onChange={(_e, v) => setRegex(v)}
              isDisabled={isDisabled}
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={add}
            isDisabled={isDisabled || !name.trim() || (op === "replace" && !val)}
          >
            {t("response_headers.add_button")}
          </Button>
        </div>
        {(op === "default" || op === "replace") && (
          <HelperText>
            <HelperTextItem>{t(op === "default" ? "response_headers.default_help" : "response_headers.replace_help")}</HelperTextItem>
          </HelperText>
        )}

        <div ref={bottomRef} />
      </div>
    </SectionShell>
  );
}
