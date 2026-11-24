import { useState } from "react";
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
import { SectionShell, useFlatSections } from "./sectionLayout";
import type { LbPolicy, LbPolicyArgs } from "../api";
import { SectionActions } from "./SectionActions";
import { SectionConfiguredDot } from "./SectionConfiguredDot";

export interface ExtraUpstream {
  host: string;
  port: string;
}

/** The policy arguments as edited (#285). weights[0] is the main target, weights[i + 1] extra upstream i. */
export interface LbArgsValues {
  headerField: string;
  cookieName: string;
  cookieSecret: string;
  weights: string[];
  choose: string;
}

export function emptyLbArgs(): LbArgsValues {
  return { headerField: "", cookieName: "", cookieSecret: "", weights: [], choose: "" };
}

export function lbArgsToValues(a: LbPolicyArgs | undefined): LbArgsValues {
  return {
    headerField: a?.headerField ?? "",
    cookieName: a?.cookieName ?? "",
    cookieSecret: a?.cookieSecret ?? "",
    weights: (a?.weights ?? []).map(String),
    choose: a?.chooseCount != null ? String(a.chooseCount) : "",
  };
}

/** Only the arguments the policy takes; undefined when it takes none or none are set. */
export function lbArgsFromValues(policy: LbPolicy | "", v: LbArgsValues): LbPolicyArgs | undefined {
  const out: LbPolicyArgs = {};
  if (policy === "header" && v.headerField.trim()) out.headerField = v.headerField.trim();
  if (policy === "cookie") {
    if (v.cookieName.trim()) out.cookieName = v.cookieName.trim();
    if (v.cookieSecret.trim()) out.cookieSecret = v.cookieSecret.trim();
  }
  if (policy === "weighted_round_robin" && v.weights.some(w => w.trim())) out.weights = v.weights.map(w => parseInt(w, 10));
  if (policy === "random_choose" && v.choose.trim()) out.chooseCount = parseInt(v.choose, 10);
  return Object.keys(out).length ? out : undefined;
}

const isWholeNumber = (s: string, min: number) => /^\d+$/.test(s.trim()) && parseInt(s, 10) >= min;

/** The i18n key of the first problem with the policy's arguments, or null. */
export function validateLbArgs(policy: LbPolicy | "", v: LbArgsValues, upstreamCount: number): string | null {
  if (policy === "header" && !v.headerField.trim()) return "upstreams.validation_header";
  if (policy === "weighted_round_robin") {
    const filled = v.weights.slice(0, upstreamCount);
    if (filled.length !== upstreamCount || v.weights.length > upstreamCount || filled.some(w => !isWholeNumber(w, 0))) {
      return "upstreams.validation_weights";
    }
  }
  if (policy === "random_choose" && v.choose.trim() && !isWholeNumber(v.choose, 1)) return "upstreams.validation_choose";
  return null;
}

interface Props {
  value: ExtraUpstream[];
  lbPolicy: LbPolicy | "";
  onChange: (upstreams: ExtraUpstream[], policy: LbPolicy | "") => void;
  lbArgs: LbArgsValues;
  onLbArgsChange: (args: LbArgsValues) => void;
  isDisabled?: boolean;
  /** Controlled expand state, e.g. from a parent accordion coordinating single-open-at-a-time
   *  across sections. Falls back to internal state when omitted. */
  isExpanded?: boolean;
  onToggleExpanded?: (v: boolean) => void;
}

const LB_POLICIES: LbPolicy[] = [
  "random", "round_robin", "least_conn", "first", "weighted_round_robin", "random_choose",
  "ip_hash", "client_ip_hash", "uri_hash", "header", "cookie",
];

export function UpstreamsSection({ value, lbPolicy, onChange, lbArgs, onLbArgsChange, isDisabled, isExpanded: isExpandedProp, onToggleExpanded }: Props) {
  const { t } = useTranslation();
  const flat = useFlatSections();
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
    // Weights stay paired with their upstreams: the main target is weights[0].
    if (lbArgs.weights.length > idx + 1) onLbArgsChange({ ...lbArgs, weights: lbArgs.weights.filter((_, i) => i !== idx + 1) });
  }

  const setArgs = (patch: Partial<LbArgsValues>) => onLbArgsChange({ ...lbArgs, ...patch });
  const setWeight = (i: number, w: string) => {
    const weights = [...lbArgs.weights];
    while (weights.length <= i) weights.push("");
    weights[i] = w;
    setArgs({ weights });
  };
  const weighted = lbPolicy === "weighted_round_robin";
  const argsError = value.length > 0 ? validateLbArgs(lbPolicy, lbArgs, value.length + 1) : null;
  const weightInput = (i: number, label: string) => (
    <FormGroup label={label} fieldId={`upstream-weight-${i}`} style={{ flex: "0 0 7rem" }}>
      <TextInput
        id={`upstream-weight-${i}`}
        type="number"
        value={lbArgs.weights[i] ?? ""}
        onChange={(_e, v) => setWeight(i, v)}
        isDisabled={isDisabled}
        validated={argsError === "upstreams.validation_weights" && !isWholeNumber(lbArgs.weights[i] ?? "", 0) ? "error" : "default"}
      />
    </FormGroup>
  );

  return (
    <SectionShell
      heading={t("upstreams.heading")}
      toggleContent={<>{expanded && !flat ? t("upstreams.section_hide") : t("upstreams.section_title")}{value.length > 0 && <SectionConfiguredDot />}</>}
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
            {weighted && weightInput(idx + 1, t("upstreams.field_weight"))}
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
          <>
            <FormGroup label={t("upstreams.lb_policy")} fieldId="upstream-lb-policy">
              <FormSelect
                id="upstream-lb-policy"
                value={lbPolicy}
                onChange={(_e, v) => onChange(value, v as LbPolicy | "")}
                isDisabled={isDisabled}
              >
                <FormSelectOption value="" label={t("upstreams.policy_default")} />
                {LB_POLICIES.map(p => <FormSelectOption key={p} value={p} label={t(`upstreams.policy_${p}`)} />)}
              </FormSelect>
              <FormHelperText>
                <HelperText><HelperTextItem>{t(lbPolicy ? `upstreams.policy_${lbPolicy}_help` : "upstreams.policy_default_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            </FormGroup>

            {lbPolicy === "header" && (
              <FormGroup label={t("upstreams.field_header")} fieldId="upstream-lb-header" isRequired>
                <TextInput id="upstream-lb-header" value={lbArgs.headerField} onChange={(_e, v) => setArgs({ headerField: v })} placeholder="X-User-Id" isDisabled={isDisabled} validated={argsError === "upstreams.validation_header" ? "error" : "default"} />
              </FormGroup>
            )}
            {lbPolicy === "cookie" && (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <FormGroup label={t("upstreams.field_cookie_name")} fieldId="upstream-lb-cookie-name" style={{ flex: 1 }}>
                  <TextInput id="upstream-lb-cookie-name" value={lbArgs.cookieName} onChange={(_e, v) => setArgs({ cookieName: v })} placeholder={t("common.default_value", { value: "lb" })} isDisabled={isDisabled} />
                </FormGroup>
                <FormGroup label={t("upstreams.field_cookie_secret")} fieldId="upstream-lb-cookie-secret" style={{ flex: 1 }}>
                  <TextInput id="upstream-lb-cookie-secret" value={lbArgs.cookieSecret} onChange={(_e, v) => setArgs({ cookieSecret: v })} isDisabled={isDisabled} />
                  <FormHelperText><HelperText><HelperTextItem>{t("upstreams.field_cookie_secret_help")}</HelperTextItem></HelperText></FormHelperText>
                </FormGroup>
              </div>
            )}
            {weighted && (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                {weightInput(0, t("upstreams.field_weight_main"))}
              </div>
            )}
            {lbPolicy === "random_choose" && (
              <FormGroup label={t("upstreams.field_choose")} fieldId="upstream-lb-choose">
                <TextInput id="upstream-lb-choose" type="number" value={lbArgs.choose} onChange={(_e, v) => setArgs({ choose: v })} placeholder={t("common.default_value", { value: "2" })} isDisabled={isDisabled} validated={argsError === "upstreams.validation_choose" ? "error" : "default"} />
              </FormGroup>
            )}
            {argsError && (
              <HelperText><HelperTextItem variant="error" id="upstream-lb-error">{t(argsError, { count: value.length + 1 })}</HelperTextItem></HelperText>
            )}
          </>
        )}
      </div>
    </SectionShell>
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
