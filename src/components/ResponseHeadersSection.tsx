import { useRef, useState, useEffect } from "react";
import {
  Button,
  ExpandableSection,
  Label,
  TextInput,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { HeaderOperation } from "../api";

interface Props {
  value: HeaderOperation[] | undefined;
  onChange: (v: HeaderOperation[] | undefined) => void;
  isDisabled?: boolean;
}

const PRESETS: Array<{ labelKey: string; op: HeaderOperation }> = [
  { labelKey: "preset_hsts",         op: { op: "set",    name: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" } },
  { labelKey: "preset_nosniff",      op: { op: "set",    name: "X-Content-Type-Options",    value: "nosniff" } },
  { labelKey: "preset_frame",        op: { op: "set",    name: "X-Frame-Options",           value: "SAMEORIGIN" } },
  { labelKey: "preset_referrer",     op: { op: "set",    name: "Referrer-Policy",           value: "strict-origin-when-cross-origin" } },
  { labelKey: "preset_remove_server",op: { op: "delete", name: "Server" } },
];

export function ResponseHeadersSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const ops = value ?? [];
  const [op, setOp] = useState<HeaderOperation["op"]>("set");
  const [name, setName] = useState("");
  const [val, setVal] = useState("");
  const [expanded, setExpanded] = useState(ops.length > 0);
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
      : { op, name: name.trim(), value: val };
    onChange([...ops, entry]);
    setName("");
    setVal("");
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
    <ExpandableSection
      toggleText={t("response_headers.section_title")}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => handleToggleExpand(v)}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", paddingTop: "0.25rem" }}>

        {ops.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {ops.map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <Label isCompact color={h.op === "delete" ? "red" : h.op === "add" ? "green" : "blue"}>
                  {h.op.toUpperCase()}
                </Label>
                <code style={{ fontSize: "0.85rem" }}>
                  {h.name}{h.value !== undefined ? `: ${h.value}` : ""}
                </code>
                <Button variant="plain" size="sm" isDanger onClick={() => remove(i)} isDisabled={isDisabled} aria-label="remove">
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
          <ToggleGroup aria-label="header op" isCompact>
            {(["set", "add", "delete"] as HeaderOperation["op"][]).map(o => (
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
              aria-label={t("response_headers.field_value")}
              value={val}
              onChange={(_e, v) => setVal(v)}
              placeholder={t("response_headers.field_value")}
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
            {t("response_headers.add_button")}
          </Button>
        </div>

        <div ref={bottomRef} />
      </div>
    </ExpandableSection>
  );
}
