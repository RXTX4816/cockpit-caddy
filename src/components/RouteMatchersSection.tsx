import { useState } from "react";
import {
  Button,
  ExpandableSection,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  TextInput,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { RouteMatch } from "../api";
import { SectionActions } from "./SectionActions";

interface Props {
  value: RouteMatch | undefined;
  onChange: (v: RouteMatch | undefined) => void;
  isDisabled?: boolean;
}

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;

function hasAnyMatcher(m: RouteMatch | undefined): boolean {
  if (!m) return false;
  return !!(
    m.path?.length ||
    m.host?.length ||
    m.method?.length ||
    (m.header && Object.keys(m.header).length) ||
    (m.query && Object.keys(m.query).length) ||
    m.remote_ip?.ranges.length
  );
}

function patch(current: RouteMatch | undefined, update: Partial<RouteMatch>): RouteMatch | undefined {
  const merged = { ...(current ?? {}), ...update } as RouteMatch;
  // Clean up empty arrays/objects so we can detect "no matcher"
  if (!merged.path?.length) delete merged.path;
  if (!merged.host?.length) delete merged.host;
  if (!merged.method?.length) delete merged.method;
  if (merged.header && !Object.keys(merged.header).length) delete merged.header;
  if (merged.query && !Object.keys(merged.query).length) delete merged.query;
  if (!merged.remote_ip?.ranges.length) delete merged.remote_ip;
  return Object.keys(merged).length ? merged : undefined;
}

export function RouteMatchersSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(hasAnyMatcher(value));

  // Local add-row state for each type
  const [newPath, setNewPath] = useState("");
  const [newHost, setNewHost] = useState("");
  const [newCidr, setNewCidr] = useState("");
  const [newHdrName, setNewHdrName] = useState("");
  const [newHdrVal, setNewHdrVal] = useState("");
  const [newQueryName, setNewQueryName] = useState("");
  const [newQueryVal, setNewQueryVal] = useState("");

  function clear() {
    onChange(undefined);
    setExpanded(false);
  }

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
    <ExpandableSection
      toggleText={t("matchers.section_title")}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={clear}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

        {/* Path */}
        <div>
          <strong style={{ fontSize: "0.9rem" }}>{t("matchers.type_path")}</strong>
          {paths.length > 0 && (
            <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
              {paths.map((p, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                  <code style={{ fontSize: "0.85rem" }}>{p}</code>
                  <Button variant="plain" size="sm" isDanger onClick={() => removePath(i)} isDisabled={isDisabled} aria-label="remove path">×</Button>
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
            <Button variant="secondary" size="sm" onClick={addPath} isDisabled={isDisabled || !newPath.trim()}>
              {t("matchers.add_path")}
            </Button>
          </div>
        </div>

        {/* Host */}
        <div>
          <strong style={{ fontSize: "0.9rem" }}>{t("matchers.type_host")}</strong>
          {hosts.length > 0 && (
            <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
              {hosts.map((h, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                  <code style={{ fontSize: "0.85rem" }}>{h}</code>
                  <Button variant="plain" size="sm" isDanger onClick={() => removeHost(i)} isDisabled={isDisabled} aria-label="remove host">×</Button>
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
            <Button variant="secondary" size="sm" onClick={addHost} isDisabled={isDisabled || !newHost.trim()}>
              {t("matchers.add_host")}
            </Button>
          </div>
        </div>

        {/* Method */}
        <div>
          <strong style={{ fontSize: "0.9rem" }}>{t("matchers.type_method")}</strong>
          <div style={{ marginTop: "0.35rem" }}>
            <ToggleGroup aria-label={t("matchers.type_method")} isCompact>
              {HTTP_METHODS.map(m => (
                <ToggleGroupItem
                  key={m}
                  text={m}
                  buttonId={`method-${m}`}
                  isSelected={methods.includes(m)}
                  onChange={() => !isDisabled && toggleMethod(m)}
                />
              ))}
            </ToggleGroup>
          </div>
        </div>

        {/* Header */}
        <div>
          <strong style={{ fontSize: "0.9rem" }}>{t("matchers.type_header")}</strong>
          {headers.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.35rem" }}>
              {headers.map(([name, vals]) => (
                <div key={name} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                  <Label isCompact color="blue">{name}</Label>
                  {vals.length > 0
                    ? <code style={{ fontSize: "0.85rem" }}>{vals.join(", ")}</code>
                    : <span style={{ color: "var(--pf-t--global--text--color--subtle)", fontSize: "0.8rem" }}>(present)</span>
                  }
                  <Button variant="plain" size="sm" isDanger onClick={() => removeHeader(name)} isDisabled={isDisabled} aria-label="remove header">×</Button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
            <TextInput
              aria-label={t("matchers.field_header_name")}
              placeholder={t("matchers.field_header_name")}
              value={newHdrName}
              onChange={(_e, v) => setNewHdrName(v)}
              isDisabled={isDisabled}
              style={{ flex: "1 1 10rem" }}
            />
            <TextInput
              aria-label={t("matchers.field_header_value")}
              placeholder={t("matchers.field_header_value")}
              value={newHdrVal}
              onChange={(_e, v) => setNewHdrVal(v)}
              isDisabled={isDisabled}
              style={{ flex: "2 1 12rem" }}
            />
            <Button variant="secondary" size="sm" onClick={addHeader} isDisabled={isDisabled || !newHdrName.trim()}>
              {t("request_headers.add_button")}
            </Button>
          </div>
          <FormHelperText>
            <HelperText>
              <HelperTextItem>{t("matchers.field_header_value_help")}</HelperTextItem>
            </HelperText>
          </FormHelperText>
        </div>

        {/* Query */}
        <div>
          <strong style={{ fontSize: "0.9rem" }}>{t("matchers.type_query")}</strong>
          {queryParams.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.35rem" }}>
              {queryParams.map(([name, vals]) => (
                <div key={name} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                  <Label isCompact color="teal">{name}</Label>
                  {vals.length > 0 && <code style={{ fontSize: "0.85rem" }}>{vals.join(", ")}</code>}
                  <Button variant="plain" size="sm" isDanger onClick={() => removeQuery(name)} isDisabled={isDisabled} aria-label="remove query param">×</Button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
            <TextInput
              aria-label={t("matchers.field_query_name")}
              placeholder={t("matchers.field_query_name")}
              value={newQueryName}
              onChange={(_e, v) => setNewQueryName(v)}
              isDisabled={isDisabled}
              style={{ flex: "1 1 10rem" }}
            />
            <TextInput
              aria-label={t("matchers.field_query_value")}
              placeholder={t("matchers.field_query_value")}
              value={newQueryVal}
              onChange={(_e, v) => setNewQueryVal(v)}
              isDisabled={isDisabled}
              style={{ flex: "2 1 12rem" }}
            />
            <Button variant="secondary" size="sm" onClick={addQuery} isDisabled={isDisabled || !newQueryName.trim()}>
              {t("request_headers.add_button")}
            </Button>
          </div>
        </div>

        {/* Remote IP / CIDR */}
        <div>
          <strong style={{ fontSize: "0.9rem" }}>{t("matchers.type_remote_ip")}</strong>
          {cidrs.length > 0 && (
            <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
              {cidrs.map((c, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                  <code style={{ fontSize: "0.85rem" }}>{c}</code>
                  <Button variant="plain" size="sm" isDanger onClick={() => removeCidr(i)} isDisabled={isDisabled} aria-label="remove cidr">×</Button>
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
            <Button variant="secondary" size="sm" onClick={addCidr} isDisabled={isDisabled || !newCidr.trim()}>
              {t("matchers.add_cidr")}
            </Button>
          </div>
        </div>

      </div>
    </ExpandableSection>
  );
}
