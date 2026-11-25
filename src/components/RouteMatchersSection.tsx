import { useState } from "react";
import {
  Button,
  FormGroup,
  FormSelect,
  FormSelectOption,
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

type IpKind = "client_ip" | "remote_ip";

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;
const EXPRESSION_DOCS = "https://caddyserver.com/docs/caddyfile/matchers#expression";

/** A matcher Caddy would reject: a header regexp without its header, or a file matcher without files (#331). */
export function validateRouteMatch(m: RouteMatch | undefined): boolean {
  if (!m) return false;
  const bad = (f: RouteMatchFields | undefined) => (!!f?.header_regexp?.pattern && !f.header_regexp.header.trim())
    || (!!f?.file && !f.file.try_files.length);
  return bad(m) || bad(m.not);
}

const PROTOCOLS = ["http", "https", "grpc"] as const;
const TRY_POLICIES = ["first_exist", "first_exist_fallback", "smallest_size", "largest_size", "most_recently_modified"] as const;

/** One `vars` per line: the placeholder, then its values (#331). */
export function varsToText(vars: Record<string, string[]> | undefined): string {
  return Object.entries(vars ?? {}).map(([k, v]) => [k, ...v].join(" ")).join("\n");
}

export function varsFromText(text: string): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const line of text.split("\n").map(l => l.trim()).filter(Boolean)) {
    const [name, ...values] = line.split(/\s+/);
    if (values.length) out[name] = values;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Drops empty lists/objects so "no matcher" stays detectable. */
function cleanFields<T extends RouteMatchFields>(merged: T): T {
  if (!merged.path?.length) delete merged.path;
  if (!merged.host?.length) delete merged.host;
  if (!merged.method?.length) delete merged.method;
  if (merged.header && !Object.keys(merged.header).length) delete merged.header;
  if (merged.query && !Object.keys(merged.query).length) delete merged.query;
  if (!merged.remote_ip?.ranges.length) delete merged.remote_ip;
  if (!merged.client_ip?.ranges.length) delete merged.client_ip;
  if (!merged.path_regexp?.pattern && !merged.path_regexp?.name) delete merged.path_regexp;
  if (!merged.header_regexp?.pattern && !merged.header_regexp?.header && !merged.header_regexp?.name) delete merged.header_regexp;
  if (!merged.protocol) delete merged.protocol;
  if (!merged.file?.try_files.length && !merged.file?.try_policy) delete merged.file;
  if (merged.vars && !Object.keys(merged.vars).length) delete merged.vars;
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
      heading={t("matchers.heading")}
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
  const [varsDraft, setVarsDraft] = useState(() => varsToText(value?.vars));

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

  // IP ranges (#286): client_ip (honours trusted_proxies) or remote_ip (the TCP peer). New ranges
  // go to client_ip; an existing remote_ip stays remote_ip until the user switches it.
  const [emptyIpKind, setEmptyIpKind] = useState<IpKind>("client_ip");
  const ipKind: IpKind = value?.client_ip?.ranges.length ? "client_ip" : value?.remote_ip?.ranges.length ? "remote_ip" : emptyIpKind;
  const otherKind: IpKind = ipKind === "client_ip" ? "remote_ip" : "client_ip";
  function addCidr() {
    const v = newCidr.trim();
    if (!v) return;
    const existing = value?.[ipKind]?.ranges ?? [];
    onChange(patch(value, { [ipKind]: { ranges: [...existing, v] } }));
    setNewCidr("");
  }
  function removeCidr(kind: IpKind, i: number) {
    const next = (value?.[kind]?.ranges ?? []).filter((_, idx) => idx !== i);
    onChange(patch(value, { [kind]: { ranges: next } }));
  }
  function switchIpKind(kind: IpKind) {
    setEmptyIpKind(kind);
    if (kind === ipKind) return;
    const ranges = [...(value?.[kind]?.ranges ?? []), ...(value?.[ipKind]?.ranges ?? [])];
    if (ranges.length) onChange(patch(value, { [ipKind]: { ranges: [] }, [kind]: { ranges } }));
  }

  const paths = value?.path ?? [];
  const hosts = value?.host ?? [];
  const methods = value?.method ?? [];
  const headers = Object.entries(value?.header ?? {});
  const queryParams = Object.entries(value?.query ?? {});
  const cidrs = value?.[ipKind]?.ranges ?? [];
  // Both kinds at once only come from a hand-written config; the other one is listed too.
  const otherCidrs = value?.[otherKind]?.ranges ?? [];

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

      {/* Client / connection IP (#286) */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_ip")}</strong>
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", alignItems: "center" }}>
          <FormSelect
            id={`${idPrefix}-ip-kind`}
            aria-label={t("matchers.ip_kind")}
            value={ipKind}
            onChange={(_e, v) => switchIpKind(v as IpKind)}
            isDisabled={isDisabled}
            style={{ maxWidth: "16rem" }}
          >
            <FormSelectOption value="client_ip" label={text("matchers.ip_kind_client")} />
            <FormSelectOption value="remote_ip" label={text("matchers.ip_kind_remote")} />
          </FormSelect>
        </div>
        <HelperText style={{ marginTop: "0.25rem" }}>
          <HelperTextItem>{text(ipKind === "client_ip" ? "matchers.ip_kind_client_help" : "matchers.ip_kind_remote_help")}</HelperTextItem>
        </HelperText>
        {cidrs.length > 0 && (
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
            {cidrs.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                <code style={{ fontSize: "0.85rem" }}>{c}</code>
                <Button variant="plain" size="sm" isDanger onClick={() => removeCidr(ipKind, i)} isDisabled={isDisabled} aria-label={t("matchers.remove_cidr")}>×</Button>
              </span>
            ))}
          </div>
        )}
        {otherCidrs.length > 0 && (
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem", alignItems: "center" }}>
            <small>{text(otherKind === "client_ip" ? "matchers.ip_kind_client" : "matchers.ip_kind_remote")}:</small>
            {otherCidrs.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                <code style={{ fontSize: "0.85rem" }}>{c}</code>
                <Button variant="plain" size="sm" isDanger onClick={() => removeCidr(otherKind, i)} isDisabled={isDisabled} aria-label={t("matchers.remove_cidr")}>×</Button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem" }}>
          <TextInput
            aria-label={t("matchers.ip_range")}
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

      {/* Regular expressions, protocol, files and variables (#331) */}
      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_path_regexp")}</strong>
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
          <TextInput
            aria-label={t("matchers.field_regexp_name")}
            placeholder={text("matchers.field_regexp_name")}
            value={value?.path_regexp?.name ?? ""}
            onChange={(_e, v) => onChange(patch(value, { path_regexp: { pattern: value?.path_regexp?.pattern ?? "", ...(v ? { name: v } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "1 1 8rem" }}
          />
          <TextInput
            aria-label={t("matchers.type_path_regexp")}
            placeholder="^/user/(\d+)$"
            value={value?.path_regexp?.pattern ?? ""}
            onChange={(_e, v) => onChange(patch(value, { path_regexp: { pattern: v, ...(value?.path_regexp?.name ? { name: value.path_regexp.name } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "3 1 14rem" }}
          />
        </div>
      </div>

      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_header_regexp")}</strong>
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
          <TextInput
            aria-label={t("matchers.field_header_name_regexp")}
            placeholder={text("matchers.field_header_name")}
            value={value?.header_regexp?.header ?? ""}
            onChange={(_e, v) => onChange(patch(value, { header_regexp: { header: v, pattern: value?.header_regexp?.pattern ?? "", ...(value?.header_regexp?.name ? { name: value.header_regexp.name } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "1 1 8rem" }}
          />
          <TextInput
            aria-label={t("matchers.field_regexp_name_header")}
            placeholder={text("matchers.field_regexp_name")}
            value={value?.header_regexp?.name ?? ""}
            onChange={(_e, v) => onChange(patch(value, { header_regexp: { header: value?.header_regexp?.header ?? "", pattern: value?.header_regexp?.pattern ?? "", ...(v ? { name: v } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "1 1 8rem" }}
          />
          <TextInput
            aria-label={t("matchers.type_header_regexp")}
            placeholder="^Bearer .+$"
            value={value?.header_regexp?.pattern ?? ""}
            onChange={(_e, v) => onChange(patch(value, { header_regexp: { header: value?.header_regexp?.header ?? "", pattern: v, ...(value?.header_regexp?.name ? { name: value.header_regexp.name } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "3 1 14rem" }}
          />
        </div>
        <HelperText style={{ marginTop: "0.25rem" }}>
          <HelperTextItem>{text("matchers.regexp_help")}</HelperTextItem>
        </HelperText>
      </div>

      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_protocol")}</strong>
        <div style={{ marginTop: "0.35rem" }}>
          <FormSelect
            id={`${idPrefix}-protocol`}
            aria-label={t("matchers.type_protocol")}
            value={value?.protocol ?? ""}
            onChange={(_e, v) => onChange(patch(value, { protocol: v || undefined }))}
            isDisabled={isDisabled}
            style={{ maxWidth: "16rem" }}
          >
            <FormSelectOption value="" label={text("matchers.protocol_any")} />
            {PROTOCOLS.map(p => <FormSelectOption key={p} value={p} label={p} />)}
          </FormSelect>
        </div>
      </div>

      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_file")}</strong>
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
          <TextInput
            aria-label={t("matchers.field_try_files")}
            placeholder="{path} {path}/index.html"
            value={value?.file?.try_files.join(" ") ?? ""}
            onChange={(_e, v) => onChange(patch(value, { file: { try_files: v.trim() ? v.trim().split(/\s+/) : [], ...(value?.file?.try_policy ? { try_policy: value.file.try_policy } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "3 1 14rem" }}
          />
          <FormSelect
            id={`${idPrefix}-try-policy`}
            aria-label={t("matchers.field_try_policy")}
            value={value?.file?.try_policy ?? ""}
            onChange={(_e, v) => onChange(patch(value, { file: { try_files: value?.file?.try_files ?? [], ...(v ? { try_policy: v } : {}) } }))}
            isDisabled={isDisabled}
            style={{ flex: "1 1 10rem" }}
          >
            <FormSelectOption value="" label={text("matchers.try_policy_default")} />
            {TRY_POLICIES.map(p => <FormSelectOption key={p} value={p} label={p} />)}
          </FormSelect>
        </div>
        <HelperText style={{ marginTop: "0.25rem" }}>
          <HelperTextItem>{text("matchers.file_help")}</HelperTextItem>
        </HelperText>
      </div>

      <div>
        <strong style={{ fontSize: "0.9rem" }}>{text("matchers.type_vars")}</strong>
        <TextArea
          aria-label={t("matchers.type_vars")}
          value={varsDraft}
          onChange={(_e, v) => { setVarsDraft(v); onChange(patch(value, { vars: varsFromText(v) })); }}
          isDisabled={isDisabled}
          resizeOrientation="vertical"
          rows={2}
          placeholder="{host} example.com www.example.com"
          style={{ marginTop: "0.35rem", fontFamily: "var(--pf-t--global--font--family--mono)" }}
        />
        <HelperText style={{ marginTop: "0.25rem" }}>
          <HelperTextItem>{text("matchers.vars_help")}</HelperTextItem>
        </HelperText>
      </div>
    </>
  );
}
