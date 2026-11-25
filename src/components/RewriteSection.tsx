import { useRef, useState, useEffect } from "react";
import {
  Button,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { SectionShell } from "./sectionLayout";
import type { QueryOp, RewriteConfig } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

type RewriteType = "none" | RewriteConfig["type"];

const TYPES: RewriteType[] = ["none", "strip_prefix", "add_prefix", "strip_suffix", "regex", "uri_replace", "query", "method"];
const QUERY_OPS: QueryOp["op"][] = ["set", "add", "delete", "rename", "replace"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface Props {
  value: RewriteConfig | undefined;
  onChange: (v: RewriteConfig | undefined) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

/** A query change without the fields its operation does not use (#332). */
export function validateRewrite(value: RewriteConfig | undefined): boolean {
  if (!value) return false;
  if (value.type === "uri_replace") return !value.find;
  if (value.type === "method") return !value.method.trim();
  if (value.type === "query") return !value.ops.length || value.ops.some(o => !o.key.trim() || (o.op === "replace" && !o.search));
  if (value.type === "regex") return !value.find;
  return !value.value.trim();
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
    if (next === "none") onChange(undefined);
    else if (next === "regex") onChange({ type: "regex", find: "", replace: "" });
    else if (next === "uri_replace") onChange({ type: "uri_replace", find: "", replace: "" });
    else if (next === "query") onChange({ type: "query", ops: [{ op: "set", key: "", value: "" }] });
    else if (next === "method") onChange({ type: "method", method: "GET" });
    else onChange({ type: next, value: "" });
  }

  // Scroll when a type with extra inputs is selected
  const prevType = useRef<RewriteType>(type);
  useEffect(() => {
    if (type !== "none" && type !== prevType.current) scrollToBottom();
    prevType.current = type;
  }, [type]);

  const err = validateRewrite(value);
  const oneValue = value && "value" in value ? value : undefined;

  function updateOp(idx: number, patch: Partial<QueryOp>) {
    if (value?.type !== "query") return;
    onChange({ type: "query", ops: value.ops.map((o, i) => i === idx ? { ...o, ...patch } : o) });
  }

  return (
    <SectionShell
      heading={t("rewrite.heading")}
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
        <FormSelect
          id="rw-type"
          aria-label={t("rewrite.type_aria")}
          value={type}
          onChange={(_e, v) => !isDisabled && setType(v as RewriteType)}
          isDisabled={isDisabled}
          style={{ maxWidth: "20rem" }}
        >
          {TYPES.map(opt => <FormSelectOption key={opt} value={opt} label={t(`rewrite.type_${opt}`)} />)}
        </FormSelect>

        {oneValue && (value?.type === "strip_prefix" || value?.type === "add_prefix" || value?.type === "strip_suffix") && (
          <FormGroup label={value.type === "strip_suffix" ? t("rewrite.field_suffix") : t("rewrite.field_prefix")} fieldId="rw-prefix">
            <TextInput
              id="rw-prefix"
              value={oneValue.value}
              onChange={(_e, v) => onChange({ type: value.type, value: v } as RewriteConfig)}
              placeholder={value.type === "strip_prefix"
                ? t("rewrite.field_prefix_placeholder_strip")
                : value.type === "strip_suffix" ? t("rewrite.field_suffix_placeholder")
                : t("rewrite.field_prefix_placeholder_add")}
              isDisabled={isDisabled}
              style={{ maxWidth: "20rem" }}
            />
          </FormGroup>
        )}

        {value?.type === "regex" && (
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <FormGroup label={t("rewrite.field_find")} fieldId="rw-find" style={{ flex: "1 1 12rem" }}>
              <TextInput
                id="rw-find"
                value={value.find}
                onChange={(_e, v) => onChange({ type: "regex", find: v, replace: value.replace })}
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
                value={value.replace}
                onChange={(_e, v) => onChange({ type: "regex", find: value.find, replace: v })}
                placeholder={t("rewrite.field_replace_placeholder")}
                isDisabled={isDisabled}
              />
            </FormGroup>
          </div>
        )}

        {value?.type === "uri_replace" && (
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <FormGroup label={t("rewrite.field_text_find")} fieldId="rw-uri-find" style={{ flex: "1 1 12rem" }}>
              <TextInput id="rw-uri-find" value={value.find} onChange={(_e, v) => onChange({ ...value, find: v })} placeholder="/old" isDisabled={isDisabled} />
            </FormGroup>
            <FormGroup label={t("rewrite.field_replace")} fieldId="rw-uri-replace" style={{ flex: "1 1 12rem" }}>
              <TextInput id="rw-uri-replace" value={value.replace} onChange={(_e, v) => onChange({ ...value, replace: v })} placeholder="/new" isDisabled={isDisabled} />
            </FormGroup>
            <FormGroup label={t("rewrite.field_limit")} fieldId="rw-uri-limit" style={{ flex: "0 1 8rem" }}>
              <TextInput
                id="rw-uri-limit"
                type="number"
                value={value.limit != null ? String(value.limit) : ""}
                onChange={(_e, v) => onChange({ type: "uri_replace", find: value.find, replace: value.replace, ...(parseInt(v, 10) > 0 ? { limit: parseInt(v, 10) } : {}) })}
                placeholder={t("rewrite.field_limit_placeholder")}
                isDisabled={isDisabled}
              />
            </FormGroup>
          </div>
        )}

        {value?.type === "method" && (
          <FormGroup label={t("rewrite.field_method")} fieldId="rw-method">
            <TextInput
              id="rw-method"
              value={value.method}
              onChange={(_e, v) => onChange({ type: "method", method: v.toUpperCase().replace(/\s/g, "") })}
              placeholder={METHODS[0]}
              isDisabled={isDisabled}
              style={{ maxWidth: "12rem" }}
            />
          </FormGroup>
        )}

        {value?.type === "query" && (
          <>
            {value.ops.map((o, idx) => (
              <div key={idx} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                <FormGroup label={t("rewrite.query_op")} fieldId={`rw-q-op-${idx}`} style={{ flex: "0 1 9rem" }}>
                  <FormSelect id={`rw-q-op-${idx}`} value={o.op} onChange={(_e, v) => updateOp(idx, { op: v as QueryOp["op"] })} isDisabled={isDisabled}>
                    {QUERY_OPS.map(op => <FormSelectOption key={op} value={op} label={t(`rewrite.query_op_${op}`)} />)}
                  </FormSelect>
                </FormGroup>
                <FormGroup label={t("rewrite.query_key")} fieldId={`rw-q-key-${idx}`} style={{ flex: "1 1 8rem" }}>
                  <TextInput id={`rw-q-key-${idx}`} value={o.key} onChange={(_e, v) => updateOp(idx, { key: v })} placeholder="page" isDisabled={isDisabled} />
                </FormGroup>
                {(o.op === "set" || o.op === "add" || o.op === "rename") && (
                  <FormGroup label={o.op === "rename" ? t("rewrite.query_new_key") : t("rewrite.query_value")} fieldId={`rw-q-val-${idx}`} style={{ flex: "1 1 8rem" }}>
                    <TextInput id={`rw-q-val-${idx}`} value={o.value ?? ""} onChange={(_e, v) => updateOp(idx, { value: v })} isDisabled={isDisabled} />
                  </FormGroup>
                )}
                {o.op === "replace" && (
                  <>
                    <FormGroup label={t("rewrite.query_search")} fieldId={`rw-q-search-${idx}`} style={{ flex: "1 1 8rem" }}>
                      <TextInput id={`rw-q-search-${idx}`} value={o.search ?? ""} onChange={(_e, v) => updateOp(idx, { search: v })} placeholder="^(\d+)$" isDisabled={isDisabled} />
                    </FormGroup>
                    <FormGroup label={t("rewrite.field_replace")} fieldId={`rw-q-replace-${idx}`} style={{ flex: "1 1 8rem" }}>
                      <TextInput id={`rw-q-replace-${idx}`} value={o.replace ?? ""} onChange={(_e, v) => updateOp(idx, { replace: v })} placeholder="$1" isDisabled={isDisabled} />
                    </FormGroup>
                  </>
                )}
                <Button
                  variant="plain"
                  aria-label={t("rewrite.query_remove")}
                  isDisabled={isDisabled || value.ops.length < 2}
                  onClick={() => onChange({ type: "query", ops: value.ops.filter((_, i) => i !== idx) })}
                >✕</Button>
              </div>
            ))}
            <div>
              <Button variant="link" isInline isDisabled={isDisabled} onClick={() => onChange({ type: "query", ops: [...value.ops, { op: "set", key: "", value: "" }] })}>
                + {t("rewrite.query_add")}
              </Button>
            </div>
          </>
        )}

        {value && err && (
          <FormHelperText><HelperText><HelperTextItem variant="error">{t("rewrite.invalid")}</HelperTextItem></HelperText></FormHelperText>
        )}

        <div ref={bottomRef} />
      </div>
    </SectionShell>
  );
}
