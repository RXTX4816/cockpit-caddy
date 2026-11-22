import { useState } from "react";
import {
  Button,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  TextArea,
  TextInput,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { SectionShell } from "./sectionLayout";
import type { RouteMatch, RouteMatchFields } from "../api";
import { hasAnyMatcher } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

interface Props {
  value: RouteMatch | undefined;
  onChange: (v: RouteMatch | undefined) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;
const EXPRESSION_DOCS = "https://caddyserver.com/docs/caddyfile/matchers#expression";

/** Drops empty lists/objects so "no matcher" stays detectable. */
function cleanFields<T extends RouteMatchFields>(merged: T): T {
  if (!merged.path?.length) delete merged.path;
  if (!merged.host?.length) delete merged.host;
  if (!merged.method?.length) delete merged.method;
  if (merged.header && !Object.keys(merged.header).length) delete merged.header;
  if (merged.query && !Object.keys(merged.query).length) delete merged.query;
  if (!merged.remote_ip?.ranges.length) delete merged.remote_ip;
  return merged;
}

function patchFields(current: RouteMatchFields | undefined, update: Partial<RouteMatchFields>): RouteMatchFields | undefined {
  const merged = cleanFields({ ...(current ?? {}), ...update });
  return Object.keys(merged).length ? merged : undefined;
}

function withPart(current: RouteMatch | undefined, update: Partial<RouteMatch>): RouteMatch | undefined {
  const merged = cleanFields({ ...(current ?? {}), ...update } as RouteMatch);
  if (!merged.not || !Object.keys(merged.not).length) delete merged.not;
  if (!merged.expression?.trim()) delete merged.expression;
  return Object.keys(merged).length ? merged : undefined;
}

export function RouteMatchersSection({ value, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(hasAnyMatcher(value));
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function clear() {
    onChange(undefined);
    setExpanded(false);
  }

  const { not, expression, ...include } = value ?? {};

  return (
    <SectionShell
      toggleContent={<>{t("matchers.section_title")}{hasAnyMatcher(value) && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={clear}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <MatcherFields
          value={include}
          onChange={fields => onChange(withPart({ not, expression }, fields ?? {}))}
          isDisabled={isDisabled}
          idPrefix=""
        />
        <div role="group" aria-label={t("matchers.exclude_title")} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div>
            <Title headingLevel="h4" size="md">{t("matchers.exclude_title")}</Title>
            <HelperText>
              <HelperTextItem>{t("matchers.exclude_help")}</HelperTextItem>
            </HelperText>
          </div>
          <MatcherFields
            value={not}
            onChange={fields => onChange(withPart(value, { not: fields }))}
            isDisabled={isDisabled}
            idPrefix="not-"
            labelPrefix={t("matchers.exclude_prefix")}
          />
        </div>
        <FormGroup label={t("matchers.expression_label")} fieldId="matcher-expression">
          <TextArea
            id="matcher-expression"
            value={expression ?? ""}
            onChange={(_e, v) => onChange(withPart(value, { expression: v }))}
            isDisabled={isDisabled}
            resizeOrientation="vertical"
            rows={2}
            style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}
          />
          <FormHelperText>
            <HelperText>
              <HelperTextItem>
                {t("matchers.expression_help")}{" "}
                <a href={EXPRESSION_DOCS} target="_blank" rel="noopener noreferrer">{t("matchers.expression_docs")}</a>
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>
      </div>
    </SectionShell>
  );
}

interface FieldsProps {
  value: RouteMatchFields | undefined;
  onChange: (v: RouteMatchFields | undefined) => void;
  isDisabled?: boolean;
  /** Keeps element ids unique when the include and exclude groups are both on screen. */
  idPrefix: string;
  /** Prepended to every accessible name in the exclude group ("Exclude: Path"). */
  labelPrefix?: string;
}

/** The path / host / method / header / query / remote IP editors, for one matcher set. */
function MatcherFields({ value, onChange, isDisabled, idPrefix, labelPrefix }: FieldsProps) {
  const { t: translate } = useTranslation();
  const t = (key: string) => labelPrefix ? `${labelPrefix} ${translate(key)}` : translate(key);
  const text = (key: string) => translate(key);

  // Local add-row state for each type
  const [newPath, setNewPath] = useState("");
  const [newHost, setNewHost] = useState("");
  const [newCidr, setNewCidr] = useState("");
  const [newHdrName, setNewHdrName] = useState("");
  const [newHdrVal, setNewHdrVal] = useState("");
  const [newQueryName, setNewQueryName] = useState("");
  const [newQueryVal, setNewQueryVal] = useState("");
  const patch = patchFields;

  // Path
  function addPath() {
    const v = newPath.trim();
    if (!v) return;
    onChange(patch(value, { path: [...(value?.path ?? []), v] }));
    setNewPath("");
  }
  function removePath(i: number) {
    const next = (value?.path ?? []).filter((_, idx) => idx !== i);
    onChange(patch(value, { path: next }));
  }

  // Host
  function addHost() {
    const v = newHost.trim();
    if (!v) return;
    onChange(patch(value, { host: [...(value?.host ?? []), v] }));
    setNewHost("");
  }
  function removeHost(i: number) {
    const next = (value?.host ?? []).filter((_, idx) => idx !== i);
    onChange(patch(value, { host: next }));
  }

  // Method
  function toggleMethod(m: string) {
    const current = value?.method ?? [];
    const next = current.includes(m) ? current.filter(x => x !== m) : [...current, m];
    onChange(patch(value, { method: next }));
  }

  // Header
  function addHeader() {
    const name = newHdrName.trim();
    if (!name) return;
    const vals = newHdrVal.trim() ? [newHdrVal.trim()] : [];
    const existing = value?.header ?? {};
    onChange(patch(value, { header: { ...existing, [name]: vals } }));
    setNewHdrName("");
    setNewHdrVal("");
  }
  function removeHeader(name: string) {
    if (!value?.header) return;
    const h = { ...value.header };
    delete h[name];
    onChange(patch(value, { header: h }));
  }

  // Query
  function addQuery() {
    const name = newQueryName.trim();
    if (!name) return;
    const vals = newQueryVal.trim() ? [newQueryVal.trim()] : [];
    const existing = value?.query ?? {};
    onChange(patch(value, { query: { ...existing, [name]: vals } }));
    setNewQueryName("");
    setNewQueryVal("");
  }
  function removeQuery(name: string) {
    if (!value?.query) return;
    const q = { ...value.query };
    delete q[name];
    onChange(patch(value, { query: q }));
  }

  // Remote IP
  function addCidr() {
    const v = newCidr.trim();
    if (!v) return;
    const existing = value?.remote_ip?.ranges ?? [];
    onChange(patch(value, { remote_ip: { ranges: [...existing, v] } }));
    setNewCidr("");
  }
  function removeCidr(i: number) {
    const next = (value?.remote_ip?.ranges ?? []).filter((_, idx) => idx !== i);
    onChange(patch(value, { remote_ip: { ranges: next } }));
  }

  const paths = value?.path ?? [];
  const hosts = value?.host ?? [];
  const methods = value?.method ?? [];
  const headers = Object.entries(value?.header ?? {});
  const queryParams = Object.entries(value?.query ?? {});
  const cidrs = value?.remote_ip?.ranges ?? [];

  return (
    <>
      {/* Path */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_path")}</strong>
        {paths.length > 0 && (
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
            {paths.map((p, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                <code style={{ fontSize: "0.85rem" }}>{p}</code>
                <Button variant="plain" size="sm" isDanger onClick={() => removePath(i)} isDisabled={isDisabled} aria-label={t("matchers.remove_path")}>×</Button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem" }}>
          <TextInput
            aria-label={t("matchers.type_path")}
            placeholder="/api/*"
            value={newPath}
            onChange={(_e, v) => setNewPath(v)}
            isDisabled={isDisabled}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addPath(); } }}
            style={{ flex: "1 1 12rem" }}
          />
          <Button variant="secondary" size="sm" onClick={addPath} isDisabled={isDisabled || !newPath.trim()} aria-label={labelPrefix ? t("matchers.add_path") : undefined}>
            {text("matchers.add_path")}
          </Button>
        </div>
      </div>

      {/* Host */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_host")}</strong>
        {hosts.length > 0 && (
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
            {hosts.map((h, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                <code style={{ fontSize: "0.85rem" }}>{h}</code>
                <Button variant="plain" size="sm" isDanger onClick={() => removeHost(i)} isDisabled={isDisabled} aria-label={t("matchers.remove_host")}>×</Button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem" }}>
          <TextInput
            aria-label={t("matchers.type_host")}
            placeholder="example.com"
            value={newHost}
            onChange={(_e, v) => setNewHost(v)}
            isDisabled={isDisabled}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addHost(); } }}
            style={{ flex: "1 1 12rem" }}
          />
          <Button variant="secondary" size="sm" onClick={addHost} isDisabled={isDisabled || !newHost.trim()} aria-label={labelPrefix ? t("matchers.add_host") : undefined}>
            {text("matchers.add_host")}
          </Button>
        </div>
      </div>

      {/* Method */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_method")}</strong>
        <div style={{ marginTop: "0.35rem" }}>
          <ToggleGroup aria-label={t("matchers.type_method")} isCompact>
            {HTTP_METHODS.map(m => (
              <ToggleGroupItem
                key={m}
                text={m}
                buttonId={`method-${idPrefix}${m}`}
                isSelected={methods.includes(m)}
                onChange={() => !isDisabled && toggleMethod(m)}
              />
            ))}
          </ToggleGroup>
        </div>
      </div>

      {/* Header */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_header")}</strong>
        {headers.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.35rem" }}>
            {headers.map(([name, vals]) => (
              <div key={name} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                <Label isCompact color="blue">{name}</Label>
                {vals.length > 0
                  ? <code style={{ fontSize: "0.85rem" }}>{vals.join(", ")}</code>
                  : <span style={{ color: "var(--pf-t--global--text--color--subtle)", fontSize: "0.8rem" }}>{text("matchers.header_present")}</span>
                }
                <Button variant="plain" size="sm" isDanger onClick={() => removeHeader(name)} isDisabled={isDisabled} aria-label={t("matchers.remove_header")}>×</Button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
          <TextInput
            aria-label={t("matchers.field_header_name")}
            placeholder={text("matchers.field_header_name")}
            value={newHdrName}
            onChange={(_e, v) => setNewHdrName(v)}
            isDisabled={isDisabled}
            style={{ flex: "1 1 10rem" }}
          />
          <TextInput
            aria-label={t("matchers.field_header_value")}
            placeholder={text("matchers.field_header_value")}
            value={newHdrVal}
            onChange={(_e, v) => setNewHdrVal(v)}
            isDisabled={isDisabled}
            style={{ flex: "2 1 12rem" }}
          />
          <Button variant="secondary" size="sm" onClick={addHeader} isDisabled={isDisabled || !newHdrName.trim()} aria-label={labelPrefix ? t("request_headers.add_button") : undefined}>
            {text("request_headers.add_button")}
          </Button>
        </div>
        <FormHelperText>
          <HelperText>
            <HelperTextItem>{text("matchers.field_header_value_help")}</HelperTextItem>
          </HelperText>
        </FormHelperText>
      </div>

      {/* Query */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_query")}</strong>
        {queryParams.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.35rem" }}>
            {queryParams.map(([name, vals]) => (
              <div key={name} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                <Label isCompact color="teal">{name}</Label>
                {vals.length > 0 && <code style={{ fontSize: "0.85rem" }}>{vals.join(", ")}</code>}
                <Button variant="plain" size="sm" isDanger onClick={() => removeQuery(name)} isDisabled={isDisabled} aria-label={t("matchers.remove_query")}>×</Button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
          <TextInput
            aria-label={t("matchers.field_query_name")}
            placeholder={text("matchers.field_query_name")}
            value={newQueryName}
            onChange={(_e, v) => setNewQueryName(v)}
            isDisabled={isDisabled}
            style={{ flex: "1 1 10rem" }}
          />
          <TextInput
            aria-label={t("matchers.field_query_value")}
            placeholder={text("matchers.field_query_value")}
            value={newQueryVal}
            onChange={(_e, v) => setNewQueryVal(v)}
            isDisabled={isDisabled}
            style={{ flex: "2 1 12rem" }}
          />
          <Button variant="secondary" size="sm" onClick={addQuery} isDisabled={isDisabled || !newQueryName.trim()} aria-label={labelPrefix ? t("request_headers.add_button") : undefined}>
            {text("request_headers.add_button")}
          </Button>
        </div>
      </div>

      {/* Remote IP / CIDR */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_remote_ip")}</strong>
        {cidrs.length > 0 && (
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
            {cidrs.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                <code style={{ fontSize: "0.85rem" }}>{c}</code>
                <Button variant="plain" size="sm" isDanger onClick={() => removeCidr(i)} isDisabled={isDisabled} aria-label={t("matchers.remove_cidr")}>×</Button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem" }}>
          <TextInput
            aria-label={t("matchers.type_remote_ip")}
            placeholder="10.0.0.0/8"
            value={newCidr}
            onChange={(_e, v) => setNewCidr(v)}
            isDisabled={isDisabled}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCidr(); } }}
            style={{ flex: "1 1 12rem" }}
          />
          <Button variant="secondary" size="sm" onClick={addCidr} isDisabled={isDisabled || !newCidr.trim()} aria-label={labelPrefix ? t("matchers.add_cidr") : undefined}>
            {text("matchers.add_cidr")}
          </Button>
        </div>
      </div>
    </>
  );
}
