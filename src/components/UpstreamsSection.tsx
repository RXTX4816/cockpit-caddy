import { useState } from "react";
import {
  Button,
  ExpandableSection,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { LbPolicy } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface ExtraUpstream {
  host: string;
  port: string;
}

interface Props {
  value: ExtraUpstream[];
  lbPolicy: LbPolicy | "";
  onChange: (upstreams: ExtraUpstream[], policy: LbPolicy | "") => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

const LB_POLICIES: Array<{ value: LbPolicy; labelKey: string }> = [
  { value: "round_robin", labelKey: "upstreams.policy_round_robin" },
  { value: "random",      labelKey: "upstreams.policy_random" },
  { value: "least_conn",  labelKey: "upstreams.policy_least_conn" },
  { value: "first",       labelKey: "upstreams.policy_first" },
];

export function UpstreamsSection({ value, lbPolicy, onChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const [internalExpanded, setInternalExpanded] = useState(value.length > 0);
  const expanded = isExpandedProp ?? internalExpanded;
  const setExpanded = onToggleExpanded ?? setInternalExpanded;

  function updateUpstream(idx: number, patch: Partial<ExtraUpstream>) {
    const next = value.map((u, i) => i === idx ? { ...u, ...patch } : u);
    onChange(next, lbPolicy);
  }

  function addUpstream() {
    onChange([...value, { host: "localhost", port: "" }], lbPolicy);
    setExpanded(true);
  }

  function removeUpstream(idx: number) {
    const next = value.filter((_, i) => i !== idx);
    onChange(next, next.length > 0 ? lbPolicy : "");
  }

  return (
    <ExpandableSection
      toggleContent={<>{expanded ? t("upstreams.section_hide") : t("upstreams.section_title")}{value.length > 0 && <SectionConfiguredDot />}</>}
      onToggle={(_e, v) => setExpanded(v)}
      isExpanded={expanded}
      style={{ marginTop: "var(--pf-v6-global--spacer--md)" }}
    >
      <SectionActions
        onClear={() => { onChange([], ""); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {value.map((u, idx) => (
          <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
            <FormGroup label={t("upstreams.field_host")} fieldId={`upstream-host-${idx}`} style={{ flex: 2 }}>
              <TextInput
                id={`upstream-host-${idx}`}
                value={u.host}
                onChange={(_e, v) => updateUpstream(idx, { host: v })}
                placeholder="localhost"
                isDisabled={isDisabled}
              />
            </FormGroup>
            <FormGroup label={t("upstreams.field_port")} fieldId={`upstream-port-${idx}`} style={{ flex: 1 }}>
              <TextInput
                id={`upstream-port-${idx}`}
                type="number"
                value={u.port}
                onChange={(_e, v) => updateUpstream(idx, { port: v })}
                placeholder="8080"
                isDisabled={isDisabled}
                validated={u.port && (isNaN(parseInt(u.port, 10)) || parseInt(u.port, 10) < 1 || parseInt(u.port, 10) > 65535) ? "error" : "default"}
              />
              {u.port && (isNaN(parseInt(u.port, 10)) || parseInt(u.port, 10) < 1 || parseInt(u.port, 10) > 65535) && (
                <FormHelperText>
                  <HelperText><HelperTextItem variant="error">{t("upstreams.validation_port")}</HelperTextItem></HelperText>
                </FormHelperText>
              )}
            </FormGroup>
            <div style={{ paddingTop: "1.6rem" }}>
              <Button variant="plain" isDanger size="sm" onClick={() => removeUpstream(idx)} isDisabled={isDisabled}>
                {t("upstreams.remove_button")}
              </Button>
            </div>
          </div>
        ))}

        <div>
          <Button variant="link" isInline size="sm" onClick={addUpstream} isDisabled={isDisabled}>
            {t("upstreams.add_button")}
          </Button>
        </div>

        {value.length > 0 && (
          <FormGroup label={t("upstreams.lb_policy")} fieldId="upstream-lb-policy">
            <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
              {LB_POLICIES.map(p => (
                <Button
                  key={p.value}
                  variant={lbPolicy === p.value ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => onChange(value, p.value)}
                  isDisabled={isDisabled}
                >
                  {t(p.labelKey)}
                </Button>
              ))}
            </div>
          </FormGroup>
        )}
      </div>
    </ExpandableSection>
  );
}

export function validateUpstreams(upstreams: ExtraUpstream[]): string | null {
  for (const u of upstreams) {
    if (!u.host.trim()) return "upstreams.validation_host";
    const p = parseInt(u.port, 10);
    if (!u.port || isNaN(p) || p < 1 || p > 65535) return "upstreams.validation_port";
  }
  return null;
}
