import { useState, useEffect } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ExpandableSection,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Spinner,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { MtlsMode, TlsProtocolVersion } from "../api";
import { readFile, parseCertDetails, type CertDetails } from "../api";
import { SectionActions } from "./SectionActions";

export interface TlsValues {
  protocolMin: TlsProtocolVersion | "";
  protocolMax: TlsProtocolVersion | "";
  cipherSuites: string[];
  curves: string[];
  clientAuthMode: MtlsMode | "";
  trustedCaFile: string;
  certLifetime: string;
  renewalWindowRatio: string;
  /** Bring-your-own certificate (#152) — mutually exclusive with certLifetime/
   *  renewalWindowRatio, which only apply to Caddy's own internal issuer. */
  customCertFile: string;
  customKeyFile: string;
  customCaFile: string;
}

const TLS_EMPTY: TlsValues = {
  protocolMin: "",
  protocolMax: "",
  cipherSuites: [],
  curves: [],
  clientAuthMode: "",
  trustedCaFile: "",
  certLifetime: "",
  renewalWindowRatio: "",
  customCertFile: "",
  customKeyFile: "",
  customCaFile: "",
};

// Caddy's internal-issuer `lifetime` accepts Go's standard duration units plus "d",
// but rejects "y" ("unknown unit y") — express a year as 365d instead.
function isLifetimeDuration(v: string): boolean {
  return !v || /^\d+(\.\d+)?(ns|us|ms|s|m|h|d)$/.test(v.trim());
}

function isRenewalRatio(v: string): boolean {
  if (!v) return true;
  const n = Number(v.trim());
  return !isNaN(n) && n > 0 && n < 1;
}

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
  /**
   * True when this proxy/server has no hostname. Caddy can only scope an
   * internal-issuer automation policy by hostname (`subjects`); without one,
   * the lifetime/renewal window below is the single shared setting for every
   * other hostless proxy too — not just this one.
   */
  hostless?: boolean;
}

function isConfigured(v: TlsValues): boolean {
  return !!(
    v.protocolMin || v.protocolMax || v.cipherSuites.length || v.curves.length || v.clientAuthMode
    || v.certLifetime || v.renewalWindowRatio || v.customCertFile || v.customKeyFile || v.customCaFile
  );
}

function hasCustomCert(v: TlsValues): boolean {
  return !!(v.customCertFile.trim() && v.customKeyFile.trim());
}

function toggleItem<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item];
}

type FileCheckState = { status: "idle" } | { status: "checking" } | { status: "ok"; details?: CertDetails } | { status: "error"; message: string };

/** Debounced existence/readability check for a single file path, with optional cert
 *  parsing (expiry/fingerprint) once readable — used for cert/key/CA bundle fields (#152). */
function useFileCheck(path: string, parse: boolean): FileCheckState {
  const [state, setState] = useState<FileCheckState>({ status: "idle" });

  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed) { setState({ status: "idle" }); return; }
    setState({ status: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      void readFile(trimmed).then(async content => {
        if (cancelled) return;
        if (content == null) {
          setState({ status: "error", message: "tls_policy.custom_file_unreadable" });
          return;
        }
        if (!parse) { setState({ status: "ok" }); return; }
        try {
          const details = await parseCertDetails(content);
          if (!cancelled) setState({ status: "ok", details });
        } catch {
          if (!cancelled) setState({ status: "ok" });
        }
      }).catch(() => {
        if (!cancelled) setState({ status: "error", message: "tls_policy.custom_file_unreadable" });
      });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, parse]);

  return state;
}

function FileCheckStatus({ state }: { state: FileCheckState }) {
  const { t } = useTranslation();
  if (state.status === "idle") return null;
  if (state.status === "checking") {
    return (
      <FormHelperText>
        <HelperText><HelperTextItem icon={<Spinner size="sm" />}>{t("tls_policy.custom_file_checking")}</HelperTextItem></HelperText>
      </FormHelperText>
    );
  }
  if (state.status === "error") {
    return (
      <FormHelperText>
        <HelperText><HelperTextItem variant="error">{t(state.message)}</HelperTextItem></HelperText>
      </FormHelperText>
    );
  }
  if (state.details) {
    return (
      <FormHelperText>
        <HelperText>
          <HelperTextItem variant="success">
            {t("tls_policy.custom_file_valid_expiry", { date: state.details.notAfter })}
          </HelperTextItem>
        </HelperText>
      </FormHelperText>
    );
  }
  return (
    <FormHelperText>
      <HelperText><HelperTextItem variant="success">{t("tls_policy.custom_file_readable")}</HelperTextItem></HelperText>
    </FormHelperText>
  );
}

export function TlsSection({ value, onChange, isDisabled, hostless }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(isConfigured(value));

  function set(patch: Partial<TlsValues>) {
    onChange({ ...value, ...patch });
  }

  const configured = isConfigured(value);
  const toggleText = configured ? t("tls_policy.section_title_on") : t("tls_policy.section_title");
  const certLifetimeErr = !isLifetimeDuration(value.certLifetime) ? t("tls_policy.validation_duration") : null;
  const renewalWindowRatioErr = !isRenewalRatio(value.renewalWindowRatio) ? t("tls_policy.validation_ratio") : null;
  const customCert = hasCustomCert(value);

  const certCheck = useFileCheck(value.customCertFile, true);
  const keyCheck = useFileCheck(value.customKeyFile, false);
  const caCheck = useFileCheck(value.customCaFile, true);

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

      {/* Custom certificate (#152) — bring-your-own PEM files instead of Caddy issuing one */}
      <FormGroup label={t("tls_policy.custom_cert_file")} fieldId="tls-custom-cert" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <FormHelperText style={{ marginBottom: "0.25rem" }}>
          <HelperText><HelperTextItem>{t("tls_policy.custom_cert_help")}</HelperTextItem></HelperText>
        </FormHelperText>
        <TextInput
          id="tls-custom-cert"
          value={value.customCertFile}
          onChange={(_e, v) => set({ customCertFile: v })}
          placeholder="/etc/caddy/certs/example.com.pem"
          isDisabled={isDisabled}
        />
        <FileCheckStatus state={certCheck} />
      </FormGroup>

      <FormGroup label={t("tls_policy.custom_key_file")} fieldId="tls-custom-key" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <TextInput
          id="tls-custom-key"
          value={value.customKeyFile}
          onChange={(_e, v) => set({ customKeyFile: v })}
          placeholder="/etc/caddy/certs/example.com.key"
          isDisabled={isDisabled}
        />
        <FileCheckStatus state={keyCheck} />
      </FormGroup>

      <FormGroup label={t("tls_policy.custom_ca_file")} fieldId="tls-custom-ca" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
        <FormHelperText style={{ marginBottom: "0.25rem" }}>
          <HelperText><HelperTextItem>{t("tls_policy.custom_ca_help")}</HelperTextItem></HelperText>
        </FormHelperText>
        <TextInput
          id="tls-custom-ca"
          value={value.customCaFile}
          onChange={(_e, v) => set({ customCaFile: v })}
          placeholder="/etc/caddy/certs/intermediate.pem"
          isDisabled={isDisabled}
        />
        <FileCheckStatus state={caCheck} />
      </FormGroup>

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

      {/* Internal issuer certificate lifetime / renewal window — inapplicable when a custom
          certificate is loaded (#152), since Caddy isn't issuing anything in that case.
          Hostless proxies/servers also can't have their own automation policy (Caddy allows
          only one policy without a hostname), so this only works for proxies with a real
          hostname; hostless ones set it once, globally, from the Global Options tab instead. */}
      {customCert ? (
        <Alert
          variant="info"
          isInline
          title={t("tls_policy.custom_cert_lifetime_note")}
          style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}
        />
      ) : hostless ? (
        <Alert
          variant="info"
          isInline
          title={t("tls_policy.hostless_global_only_note")}
          style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}
        />
      ) : (
        <>
          <FormGroup label={t("tls_policy.cert_lifetime")} fieldId="tls-cert-lifetime" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <FormHelperText style={{ marginBottom: "0.25rem" }}>
              <HelperText><HelperTextItem>{t("tls_policy.cert_lifetime_help")}</HelperTextItem></HelperText>
            </FormHelperText>
            <TextInput
              id="tls-cert-lifetime"
              value={value.certLifetime}
              onChange={(_e, v) => set({ certLifetime: v })}
              placeholder={t("tls_policy.cert_lifetime_placeholder")}
              validated={certLifetimeErr ? "error" : "default"}
              isDisabled={isDisabled}
            />
            {certLifetimeErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{certLifetimeErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("tls_policy.renewal_window_ratio")} fieldId="tls-renewal-ratio" style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
            <FormHelperText style={{ marginBottom: "0.25rem" }}>
              <HelperText><HelperTextItem>{t("tls_policy.renewal_window_ratio_help")}</HelperTextItem></HelperText>
            </FormHelperText>
            <TextInput
              id="tls-renewal-ratio"
              value={value.renewalWindowRatio}
              onChange={(_e, v) => set({ renewalWindowRatio: v })}
              placeholder="0.33"
              validated={renewalWindowRatioErr ? "error" : "default"}
              isDisabled={isDisabled}
            />
            {renewalWindowRatioErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{renewalWindowRatioErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>
        </>
      )}

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

/** True if the free-text lifetime/renewal-window fields hold invalid values; gates dialog submit buttons. */
export function tlsValuesHaveErrors(v: TlsValues): boolean {
  return !isLifetimeDuration(v.certLifetime) || !isRenewalRatio(v.renewalWindowRatio)
    || (!!v.customCertFile.trim() !== !!v.customKeyFile.trim());
}

export function tlsValuesToAdvanced(v: TlsValues): import("../api").TlsAdvancedConfig | undefined {
  // certLifetime/renewalWindowRatio only govern Caddy's own internal issuer — meaningless
  // (and never applied by buildTlsCaddyLines) once a custom certificate (#152) is loaded.
  const certLifetime = hasCustomCert(v) ? "" : v.certLifetime;
  const renewalWindowRatio = hasCustomCert(v) ? "" : v.renewalWindowRatio;
  if (!v.protocolMin && !v.protocolMax && !v.cipherSuites.length && !v.curves.length && !certLifetime && !renewalWindowRatio) return undefined;
  return {
    protocolMin: v.protocolMin || undefined,
    protocolMax: v.protocolMax || undefined,
    cipherSuites: v.cipherSuites.length ? v.cipherSuites : undefined,
    curves: v.curves.length ? v.curves : undefined,
    certLifetime: certLifetime.trim() || undefined,
    renewalWindowRatio: renewalWindowRatio.trim() ? Number(renewalWindowRatio.trim()) : undefined,
  };
}

export function tlsValuesToCustomTls(v: TlsValues): import("../api").CustomTlsConfig | undefined {
  if (!hasCustomCert(v)) return undefined;
  return {
    certFile: v.customCertFile.trim(),
    keyFile: v.customKeyFile.trim(),
    caFile: v.customCaFile.trim() || undefined,
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
  customTls?: import("../api").CustomTlsConfig,
): TlsValues {
  return {
    protocolMin: tlsAdvanced?.protocolMin ?? "",
    protocolMax: tlsAdvanced?.protocolMax ?? "",
    cipherSuites: tlsAdvanced?.cipherSuites ?? [],
    curves: tlsAdvanced?.curves ?? [],
    certLifetime: tlsAdvanced?.certLifetime ?? "",
    renewalWindowRatio: tlsAdvanced?.renewalWindowRatio !== undefined ? String(tlsAdvanced.renewalWindowRatio) : "",
    clientAuthMode: mtls?.mode ?? "",
    trustedCaFile: mtls?.trustedCaFile ?? "",
    customCertFile: customTls?.certFile ?? "",
    customKeyFile: customTls?.keyFile ?? "",
    customCaFile: customTls?.caFile ?? "",
  };
}
