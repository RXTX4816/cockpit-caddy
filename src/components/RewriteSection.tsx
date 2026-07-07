import { useRef, useState, useEffect } from "react";
import {
  ExpandableSection,
  FormGroup,
  TextInput,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { RewriteConfig } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

type RewriteType = "none" | RewriteConfig["type"];

interface Props {
  value: RewriteConfig | undefined;
  onChange: (v: RewriteConfig | undefined) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

export function RewriteSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const type: RewriteType = value?.type ?? "none";
  const [internalExpanded, setInternalExpanded] = useState(type !== "none");
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;
  const bottomRef = useRef<HTMLDivElement>(null);

  function scrollToBottom() {
    // Defer until after the DOM update so new content is rendered
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function handleToggleExpand(isExpanded: boolean) {
    setExpanded(isExpanded);
    if (isExpanded) scrollToBottom();
  }

  function setType(next: RewriteType) {
    if (next === "none") { onChange(undefined); return; }
    if (next === "strip_prefix") onChange({ type: "strip_prefix", value: "" });
    else if (next === "add_prefix") onChange({ type: "add_prefix", value: "" });
    else onChange({ type: "regex", find: "", replace: "" });
  }

  // Scroll when a type with extra inputs is selected
  const prevType = useRef<RewriteType>(type);
  useEffect(() => {
    if (type !== "none" && type !== prevType.current) scrollToBottom();
    prevType.current = type;
  }, [type]);

  return (
    <ExpandableSection
      toggleContent={<>{t("rewrite.section_title")}{type !== "none" && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => handleToggleExpand(v)}
    >
      <SectionActions
        onClear={() => { onChange(undefined); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <ToggleGroup aria-label="rewrite type" isCompact>
          {(["none", "strip_prefix", "add_prefix", "regex"] as RewriteType[]).map(opt => (
            <ToggleGroupItem
              key={opt}
              text={t(`rewrite.type_${opt}`)}
              buttonId={`rw-type-${opt}`}
              isSelected={type === opt}
              onChange={() => !isDisabled && setType(opt)}
            />
          ))}
        </ToggleGroup>

        {(type === "strip_prefix" || type === "add_prefix") && (
          <FormGroup label={t("rewrite.field_prefix")} fieldId="rw-prefix">
            <TextInput
              id="rw-prefix"
              value={(value as Extract<RewriteConfig, { type: "strip_prefix" | "add_prefix" }>)?.value ?? ""}
              onChange={(_e, v) => onChange({ type, value: v } as RewriteConfig)}
              placeholder={type === "strip_prefix"
                ? t("rewrite.field_prefix_placeholder_strip")
                : t("rewrite.field_prefix_placeholder_add")}
              isDisabled={isDisabled}
              style={{ maxWidth: "20rem" }}
            />
          </FormGroup>
        )}

        {type === "regex" && (
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <FormGroup label={t("rewrite.field_find")} fieldId="rw-find" style={{ flex: "1 1 12rem" }}>
              <TextInput
                id="rw-find"
                value={(value as Extract<RewriteConfig, { type: "regex" }>)?.find ?? ""}
                onChange={(_e, v) => onChange({ type: "regex", find: v, replace: (value as Extract<RewriteConfig, { type: "regex" }>)?.replace ?? "" })}
                placeholder={t("rewrite.field_find_placeholder")}
                isDisabled={isDisabled}
              />
            </FormGroup>
            <FormGroup
              label={t("rewrite.field_replace")}
              fieldId="rw-replace"
              labelHelp={<span style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)" }}>{t("rewrite.field_replace_help")}</span>}
              style={{ flex: "1 1 12rem" }}
            >
              <TextInput
                id="rw-replace"
                value={(value as Extract<RewriteConfig, { type: "regex" }>)?.replace ?? ""}
                onChange={(_e, v) => onChange({ type: "regex", find: (value as Extract<RewriteConfig, { type: "regex" }>)?.find ?? "", replace: v })}
                placeholder={t("rewrite.field_replace_placeholder")}
                isDisabled={isDisabled}
              />
            </FormGroup>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </ExpandableSection>
  );
}
