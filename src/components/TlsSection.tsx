import { useState } from "react";
import {
  Button,
  Checkbox,
  ExpandableSection,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { MtlsMode, TlsProtocolVersion } from "../api";
import { SectionActions } from "./SectionActions";

export interface TlsValues {
  protocolMin: TlsProtocolVersion | "";
  protocolMax: TlsProtocolVersion | "";
  cipherSuites: string[];
  curves: string[];
  clientAuthMode: MtlsMode | "";
  trustedCaFile: string;
}

const TLS_EMPTY: TlsValues = {
  protocolMin: "",
  protocolMax: "",
  cipherSuites: [],
  curves: [],
  clientAuthMode: "",
  trustedCaFile: "",
};

const PROTOCOL_VERSIONS: Array<TlsProtocolVersion | ""> = ["", "tls1.2", "tls1.3"];
const MTLS_MODES: MtlsMode[] = ["request", "require", "verify_if_given", "require_and_verify"];
const CURVES: string[] = ["x25519", "p256", "p384", "p521"];

// Only ECDHE AEAD ciphers — Caddy's SupportedCipherSuites excludes plain RSA key exchange;
// CBC suites are Go crypto/tls "insecure" and rejected in newer Go/Caddy versions.
const CIPHER_SUITES: string[] = [
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
];

interface Props {
  value: TlsValues;
  onChange: (v: TlsValues) => void;
  isDisabled?: boolean;
}

function isConfigured(v: TlsValues): boolean {
  return !!(v.protocolMin || v.protocolMax || v.cipherSuites.length || v.curves.length || v.clientAuthMode);
}

function toggleItem<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item];
}

export function TlsSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(isConfigured(value));

  function set(patch: Partial<TlsValues>) {
    onChange({ ...value, ...patch });
  }

  const configured = isConfigured(value);
  const toggleText = configured ? t("tls_policy.section_title_on") : t("tls_policy.section_title");

  return (
    <ExpandableSection
      toggleText={toggleText}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => { onChange(TLS_EMPTY); setExpanded(false); }}
        isDisabled={isDisabled}
      />

      {/* Protocol versions */}
      <FormGroup label={t("tls_policy.protocol_min")} fieldId="tls-proto-min" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {PROTOCOL_VERSIONS.map(v => (
            <Button
              key={v || "default"}
              variant={value.protocolMin === v ? "primary" : "secondary"}
              size="sm"
              onClick={() => set({ protocolMin: v })}
              isDisabled={isDisabled}
            >
              {t(`tls_policy.proto_${v || "default"}`)}
            </Button>
          ))}
        </div>
      </FormGroup>

      <FormGroup label={t("tls_policy.protocol_max")} fieldId="tls-proto-max" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {PROTOCOL_VERSIONS.map(v => (
            <Button
              key={v || "default"}
              variant={value.protocolMax === v ? "primary" : "secondary"}
              size="sm"
              onClick={() => set({ protocolMax: v })}
              isDisabled={isDisabled}
            >
              {t(`tls_policy.proto_${v || "default"}`)}
            </Button>
          ))}
        </div>
      </FormGroup>

      {/* Cipher suites */}
      <FormGroup label={t("tls_policy.cipher_suites")} fieldId="tls-ciphers" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <FormHelperText style={{ marginBottom: "0.25rem" }}>
          <HelperText><HelperTextItem>{t("tls_policy.cipher_suites_help")}</HelperTextItem></HelperText>
        </FormHelperText>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.25rem 1rem" }}>
          {CIPHER_SUITES.map(suite => (
            <Checkbox
              key={suite}
              id={`tls-cipher-${suite}`}
              label={suite}
              isChecked={value.cipherSuites.includes(suite)}
              onChange={() => set({ cipherSuites: toggleItem(value.cipherSuites, suite) })}
              isDisabled={isDisabled}
            />
          ))}
        </div>
      </FormGroup>

      {/* Curves */}
      <FormGroup label={t("tls_policy.curves")} fieldId="tls-curves" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <FormHelperText style={{ marginBottom: "0.25rem" }}>
          <HelperText><HelperTextItem>{t("tls_policy.curves_help")}</HelperTextItem></HelperText>
        </FormHelperText>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          {CURVES.map(curve => (
            <Checkbox
              key={curve}
              id={`tls-curve-${curve}`}
              label={curve}
              isChecked={value.curves.includes(curve)}
              onChange={() => set({ curves: toggleItem(value.curves, curve) })}
              isDisabled={isDisabled}
            />
          ))}
        </div>
      </FormGroup>

      {/* mTLS */}
      <FormGroup label={t("tls_policy.client_auth_mode")} fieldId="tls-mtls-mode" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <FormHelperText style={{ marginBottom: "0.25rem" }}>
          <HelperText><HelperTextItem>{t("tls_policy.client_auth_mode_help")}</HelperTextItem></HelperText>
        </FormHelperText>
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          <Button
            variant={value.clientAuthMode === "" ? "primary" : "secondary"}
            size="sm"
            onClick={() => set({ clientAuthMode: "", trustedCaFile: "" })}
            isDisabled={isDisabled}
          >
            {t("tls_policy.client_auth_none")}
          </Button>
          {MTLS_MODES.map(mode => (
            <Button
              key={mode}
              variant={value.clientAuthMode === mode ? "primary" : "secondary"}
              size="sm"
              onClick={() => set({ clientAuthMode: mode })}
              isDisabled={isDisabled}
            >
              {t(`tls_policy.client_auth_${mode}`)}
            </Button>
          ))}
        </div>
      </FormGroup>

      {value.clientAuthMode !== "" && (
        <FormGroup label={t("tls_policy.trusted_ca_file")} fieldId="tls-trusted-ca">
          <FormHelperText style={{ marginBottom: "0.25rem" }}>
            <HelperText><HelperTextItem>{t("tls_policy.trusted_ca_file_help")}</HelperTextItem></HelperText>
          </FormHelperText>
          <TextInput
            id="tls-trusted-ca"
            value={value.trustedCaFile}
            onChange={(_e, v) => set({ trustedCaFile: v })}
            placeholder="/etc/caddy/certs/ca.pem"
            isDisabled={isDisabled}
          />
        </FormGroup>
      )}
    </ExpandableSection>
  );
}

export function tlsValuesToAdvanced(v: TlsValues): import("../api").TlsAdvancedConfig | undefined {
  if (!v.protocolMin && !v.protocolMax && !v.cipherSuites.length && !v.curves.length) return undefined;
  return {
    protocolMin: v.protocolMin || undefined,
    protocolMax: v.protocolMax || undefined,
    cipherSuites: v.cipherSuites.length ? v.cipherSuites : undefined,
    curves: v.curves.length ? v.curves : undefined,
  };
}

export function tlsValuesToMtls(v: TlsValues): import("../api").MtlsConfig | undefined {
  if (!v.clientAuthMode) return undefined;
  return {
    mode: v.clientAuthMode,
    trustedCaFile: v.trustedCaFile.trim() || undefined,
  };
}

export function tlsConfigToValues(
  tlsAdvanced: import("../api").TlsAdvancedConfig | undefined,
  mtls: import("../api").MtlsConfig | undefined,
): TlsValues {
  return {
    protocolMin: tlsAdvanced?.protocolMin ?? "",
    protocolMax: tlsAdvanced?.protocolMax ?? "",
    cipherSuites: tlsAdvanced?.cipherSuites ?? [],
    curves: tlsAdvanced?.curves ?? [],
    clientAuthMode: mtls?.mode ?? "",
    trustedCaFile: mtls?.trustedCaFile ?? "",
  };
}
