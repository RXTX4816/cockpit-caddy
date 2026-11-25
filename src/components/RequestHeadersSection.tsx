import { useRef, useState, useEffect } from "react";
import {
  Button,
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
  /** `down` edits header_down, the upstream's response headers (#324): no presets, and a replace operation. */
  variant?: "up" | "down";
}

const PRESETS: HeaderOperation[] = [
  { op: "set", name: "X-Real-IP",         value: "{remote_host}" },
  { op: "set", name: "X-Forwarded-For",   value: "{remote_host}" },
  { op: "set", name: "X-Forwarded-Proto", value: "{scheme}" },
];

export function RequestHeadersSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded, variant = "up" }: Props) {
  const down = variant === "down";
  const { t } = useTranslation();
  const ops = value ?? [];
  const [op, setOp] = useState<HeaderOperation["op"]>("set");
  const [name, setName] = useState("");
  const [val, setVal] = useState("");
  const [replacement, setReplacement] = useState("");
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
    if (!name.trim()) return;
    const entry: HeaderOperation = op === "delete"
      ? { op, name: name.trim() }
      : op === "replace"
        ? { op, name: name.trim(), value: val, replacement }
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
      heading={t(down ? "request_headers.down_heading" : "request_headers.heading")}
      toggleContent={<>{t(down ? "request_headers.down_section_title" : "request_headers.section_title")}{ops.length > 0 && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => handleToggleExpand(v)}
    >
      <SectionActions
        onClear={() => { onChange(undefined); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>

        {/* Current operations */}
        {ops.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {ops.map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <Label
                  isCompact
                  color={h.op === "delete" ? "red" : h.op === "add" ? "green" : h.op === "replace" ? "orange" : "blue"}
                >
                  {h.op.toUpperCase()}
                </Label>
                <code style={{ fontSize: "0.85rem" }}>
                  {h.name}{h.value !== undefined ? `: ${h.value}` : ""}{h.op === "replace" ? ` → ${h.replacement ?? ""}` : ""}
                </code>
                <Button
                  variant="plain"
                  size="sm"
                  isDanger
                  onClick={() => remove(i)}
                  isDisabled={isDisabled}
                  aria-label={t("common.remove_aria")}
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Presets */}
        {!down && <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--pf-t--global--text--color--subtle)" }}>
            {t("request_headers.presets_label")}:
          </span>
          {PRESETS.map(p => (
            <Button
              key={p.name}
              variant="secondary"
              size="sm"
              onClick={() => addPreset(p)}
              isDisabled={isDisabled || ops.some(h => h.name === p.name && h.op === p.op)}
            >
              {p.name}
            </Button>
          ))}
        </div>}

        {/* Add row */}
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <ToggleGroup aria-label={t("common.header_op_aria")} isCompact>
            {((down ? ["set", "add", "delete", "replace"] : ["set", "add", "delete"]) as HeaderOperation["op"][]).map(o => (
              <ToggleGroupItem
                key={o}
                text={t(`request_headers.op_${o}`)}
                buttonId={`hdr-op-${o}`}
                isSelected={op === o}
                onChange={() => !isDisabled && setOp(o)}
              />
            ))}
          </ToggleGroup>
          <TextInput
            aria-label={t("request_headers.field_name")}
            value={name}
            onChange={(_e, v) => setName(v)}
            placeholder={t("request_headers.field_name")}
            isDisabled={isDisabled}
            style={{ flex: "1 1 10rem", minWidth: "8rem" }}
          />
          {op !== "delete" && (
            <TextInput
              aria-label={t(op === "replace" ? "request_headers.field_search" : "request_headers.field_value")}
              value={val}
              onChange={(_e, v) => setVal(v)}
              placeholder={t(op === "replace" ? "request_headers.field_search" : "request_headers.field_value")}
              isDisabled={isDisabled}
              style={{ flex: "2 1 12rem", minWidth: "8rem" }}
            />
          )}
          {op === "replace" && (
            <TextInput
              aria-label={t("request_headers.field_replacement")}
              value={replacement}
              onChange={(_e, v) => setReplacement(v)}
              placeholder={t("request_headers.field_replacement")}
              isDisabled={isDisabled}
              style={{ flex: "2 1 12rem", minWidth: "8rem" }}
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={add}
            isDisabled={isDisabled || !name.trim()}
          >
            {t("request_headers.add_button")}
          </Button>
        </div>

        <div ref={bottomRef} />
      </div>
    </SectionShell>
  );
}
