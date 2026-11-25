import { useState } from "react";
import { Button, FormGroup, FormSelect, FormSelectOption, HelperText, HelperTextItem, TextInput } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { DynamicUpstreamSource } from "../api";
import { ResettableTextInput, SectionShell } from "./sectionLayout";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

/** One DNS source as typed: every field is text, resolvers are space-separated (#326). */
export interface DynamicSourceValues {
  type: "srv" | "a";
  name: string;
  port: string;
  refresh: string;
  resolvers: string;
  dialTimeout: string;
  dialFallbackDelay: string;
  gracePeriod: string;
  versions: "" | "ipv4" | "ipv6";
}

export const emptyDynamicSource = (): DynamicSourceValues => ({
  type: "srv", name: "", port: "", refresh: "", resolvers: "", dialTimeout: "", dialFallbackDelay: "", gracePeriod: "", versions: "",
});

export function dynamicUpstreamsToValues(list: DynamicUpstreamSource[] | undefined): DynamicSourceValues[] {
  return (list ?? []).map(s => ({
    type: s.type, name: s.name, port: s.port ?? "", refresh: s.refresh ?? "", resolvers: (s.resolvers ?? []).join(" "),
    dialTimeout: s.dialTimeout ?? "", dialFallbackDelay: s.dialFallbackDelay ?? "", gracePeriod: s.gracePeriod ?? "", versions: s.versions ?? "",
  }));
}

export function dynamicUpstreamsToConfig(values: DynamicSourceValues[]): DynamicUpstreamSource[] | undefined {
  const list = values.filter(v => v.name.trim()).map((v): DynamicUpstreamSource => {
    const out: DynamicUpstreamSource = { type: v.type, name: v.name.trim() };
    if (v.type === "a" && v.port.trim()) out.port = v.port.trim();
    if (v.refresh.trim()) out.refresh = v.refresh.trim();
    if (v.resolvers.trim()) out.resolvers = v.resolvers.trim().split(/\s+/);
    if (v.dialTimeout.trim()) out.dialTimeout = v.dialTimeout.trim();
    if (v.dialFallbackDelay.trim()) out.dialFallbackDelay = v.dialFallbackDelay.trim();
    if (v.gracePeriod.trim()) out.gracePeriod = v.gracePeriod.trim();
    if (v.type === "a" && v.versions) out.versions = v.versions;
    return out;
  });
  return list.length ? list : undefined;
}

const isDuration = (v: string) => !v.trim() || /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/.test(v.trim());

/** An error key for the first problem, or null. A source without a name is simply left out when saving. */
export function validateDynamicUpstreams(values: DynamicSourceValues[]): string | null {
  for (const v of values) {
    if (!v.name.trim() && Object.entries(v).some(([k, x]) => k !== "type" && !!x)) return "dynamic_upstreams.validation_name";
    if (![v.refresh, v.dialTimeout, v.dialFallbackDelay, v.gracePeriod].every(isDuration)) return "lb_retry.validation_duration";
    if (v.type === "a" && v.port.trim() && !/^[1-9]\d{0,4}$/.test(v.port.trim())) return "upstreams.validation_port";
  }
  return null;
}

interface Props {
  value: DynamicSourceValues[];
  onChange: (v: DynamicSourceValues[]) => void;
  isDisabled?: boolean;
}

export function DynamicUpstreamsSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(value.length > 0);
  const error = validateDynamicUpstreams(value);

  function update(idx: number, patch: Partial<DynamicSourceValues>) {
    onChange(value.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  const text = (idx: number, key: keyof DynamicSourceValues, label: string, placeholder: string, flex = "1 1 9rem") => (
    <FormGroup label={label} fieldId={`dyn-${key}-${idx}`} style={{ flex }}>
      <ResettableTextInput
        id={`dyn-${key}-${idx}`}
        value={value[idx][key]}
        onChange={(_e, v) => update(idx, { [key]: v })}
        placeholder={placeholder}
        isDisabled={isDisabled}
      />
    </FormGroup>
  );

  return (
    <SectionShell
      heading={t("dynamic_upstreams.heading")}
      toggleContent={<>{t("dynamic_upstreams.section_title")}{value.length > 0 && <SectionConfiguredDot />}</>}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions onClear={() => { onChange([]); setExpanded(false); }} isDisabled={isDisabled} />
      <HelperText style={{ marginBottom: "0.6rem" }}>
        <HelperTextItem>{t("dynamic_upstreams.help")}</HelperTextItem>
      </HelperText>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {value.map((s, idx) => (
          <div key={idx} style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
            <FormGroup label={t("dynamic_upstreams.type")} fieldId={`dyn-type-${idx}`} style={{ flex: "0 1 9rem" }}>
              <FormSelect
                id={`dyn-type-${idx}`}
                value={s.type}
                onChange={(_e, v) => update(idx, { type: v as "srv" | "a" })}
                isDisabled={isDisabled}
              >
                <FormSelectOption value="srv" label={t("dynamic_upstreams.type_srv")} />
                <FormSelectOption value="a" label={t("dynamic_upstreams.type_a")} />
              </FormSelect>
            </FormGroup>
            {text(idx, "name", t(s.type === "srv" ? "dynamic_upstreams.name_srv" : "dynamic_upstreams.name_a"), s.type === "srv" ? "_http._tcp.example.com" : "backend.example.com", "2 1 14rem")}
            {s.type === "a" && (
              <FormGroup label={t("upstreams.field_port")} fieldId={`dyn-port-${idx}`} style={{ flex: "0 1 6rem" }}>
                <TextInput id={`dyn-port-${idx}`} type="number" value={s.port} onChange={(_e, v) => update(idx, { port: v })} placeholder="8080" isDisabled={isDisabled} />
              </FormGroup>
            )}
            {text(idx, "refresh", t("dynamic_upstreams.refresh"), t("common.default_value", { value: "1m" }))}
            {text(idx, "resolvers", t("dynamic_upstreams.resolvers"), t("common.example_value", { value: "1.1.1.1 9.9.9.9" }), "2 1 12rem")}
            {text(idx, "dialTimeout", t("transport.dial_timeout"), t("common.default_value", { value: "10s" }))}
            {text(idx, "dialFallbackDelay", t("dynamic_upstreams.dial_fallback_delay"), t("common.default_value", { value: "300ms" }))}
            {text(idx, "gracePeriod", t("dynamic_upstreams.grace_period"), t("server_timeouts.no_timeout"))}
            {s.type === "a" && (
              <FormGroup label={t("dynamic_upstreams.versions")} fieldId={`dyn-versions-${idx}`} style={{ flex: "0 1 9rem" }}>
                <FormSelect id={`dyn-versions-${idx}`} value={s.versions} onChange={(_e, v) => update(idx, { versions: v as DynamicSourceValues["versions"] })} isDisabled={isDisabled}>
                  <FormSelectOption value="" label={t("dynamic_upstreams.versions_both")} />
                  <FormSelectOption value="ipv4" label={t("dynamic_upstreams.ipv4")} />
                  <FormSelectOption value="ipv6" label={t("dynamic_upstreams.ipv6")} />
                </FormSelect>
              </FormGroup>
            )}
            <Button variant="plain" isDanger size="sm" onClick={() => onChange(value.filter((_, i) => i !== idx))} isDisabled={isDisabled}>
              {t("upstreams.remove_button")}
            </Button>
          </div>
        ))}
        {error && <HelperText><HelperTextItem variant="error">{t(error)}</HelperTextItem></HelperText>}
        <div>
          <Button variant="link" isInline size="sm" onClick={() => onChange([...value, emptyDynamicSource()])} isDisabled={isDisabled}>
            {t("dynamic_upstreams.add_button")}
          </Button>
        </div>
      </div>
    </SectionShell>
  );
}
