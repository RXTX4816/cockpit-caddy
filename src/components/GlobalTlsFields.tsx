import { Checkbox, FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem, TextInput } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { GlobalOptions, PreferredChains } from "../api";

/** The form's view of the TLS and listener options of #329. */
export interface GlobalTlsValues {
  autoHttps: string;
  /** "" (default), "local_certs", "internal", "acme", or "custom" for an issuer read from the file. */
  issuer: string;
  customIssuer: string;
  customIssuerBody: string[] | undefined;
  keyType: string;
  defaultSni: string;
  defaultBind: string;
  ocspStaplingOff: boolean;
  chainsMode: "" | PreferredChains["mode"];
  chainsNames: string;
}

export const AUTO_HTTPS_MODES = ["off", "disable_redirects", "disable_certs", "ignore_loaded_certs"] as const;
export const KEY_TYPES = ["ed25519", "p256", "p384", "rsa2048", "rsa4096"] as const;
const SIMPLE_ISSUERS = ["internal", "acme"];

export function globalTlsToValues(o: GlobalOptions): GlobalTlsValues {
  const simple = o.certIssuer && SIMPLE_ISSUERS.includes(o.certIssuer) && !o.certIssuerBody?.length;
  return {
    autoHttps: o.autoHttps ?? "",
    issuer: o.certIssuer ? (simple ? o.certIssuer : "custom") : o.localCerts ? "local_certs" : "",
    customIssuer: o.certIssuer ?? "",
    customIssuerBody: o.certIssuerBody,
    keyType: o.keyType ?? "",
    defaultSni: o.defaultSni ?? "",
    defaultBind: o.defaultBind?.join(" ") ?? "",
    ocspStaplingOff: o.ocspStaplingOff ?? false,
    chainsMode: o.preferredChains?.mode ?? "",
    chainsNames: o.preferredChains && o.preferredChains.mode !== "smallest" ? o.preferredChains.names.join(", ") : "",
  };
}

export function globalTlsFromValues(v: GlobalTlsValues): Pick<GlobalOptions,
  "autoHttps" | "localCerts" | "certIssuer" | "certIssuerBody" | "keyType" | "defaultSni" | "defaultBind" | "ocspStaplingOff" | "preferredChains"> {
  const names = v.chainsNames.split(",").map(n => n.trim()).filter(Boolean);
  const chains: PreferredChains | undefined = v.chainsMode === "smallest" ? { mode: "smallest" }
    : v.chainsMode && names.length ? { mode: v.chainsMode, names } : undefined;
  return {
    autoHttps: v.autoHttps || undefined,
    localCerts: v.issuer === "local_certs" || undefined,
    certIssuer: v.issuer === "custom" ? v.customIssuer || undefined : SIMPLE_ISSUERS.includes(v.issuer) ? v.issuer : undefined,
    certIssuerBody: v.issuer === "custom" ? v.customIssuerBody : undefined,
    keyType: v.keyType || undefined,
    defaultSni: v.defaultSni.trim() || undefined,
    defaultBind: v.defaultBind.trim() ? v.defaultBind.trim().split(/\s+/) : undefined,
    ocspStaplingOff: v.ocspStaplingOff || undefined,
    preferredChains: chains,
  };
}

interface Props {
  value: GlobalTlsValues;
  onChange: (v: GlobalTlsValues) => void;
  isDisabled?: boolean;
}

export function GlobalTlsFields({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const set = <K extends keyof GlobalTlsValues>(key: K, v: GlobalTlsValues[K]) => onChange({ ...value, [key]: v });
  const unknownAutoHttps = value.autoHttps && !(AUTO_HTTPS_MODES as readonly string[]).includes(value.autoHttps);
  const unknownKeyType = value.keyType && !(KEY_TYPES as readonly string[]).includes(value.keyType);

  return (
    <>
      <FormGroup label={t("global_opts.auto_https")} fieldId="go-auto-https">
        <FormSelect id="go-auto-https" value={value.autoHttps} onChange={(_e, v) => set("autoHttps", v)} isDisabled={isDisabled} style={{ maxWidth: "20rem" }}>
          <FormSelectOption value="" label={t("tls_policy.proto_default")} />
          {AUTO_HTTPS_MODES.map(m => <FormSelectOption key={m} value={m} label={t(`global_opts.auto_https_${m}`)} />)}
          {unknownAutoHttps && <FormSelectOption value={value.autoHttps} label={value.autoHttps} />}
        </FormSelect>
      </FormGroup>

      <FormGroup label={t("global_opts.issuer")} fieldId="go-issuer">
        <FormSelect id="go-issuer" value={value.issuer} onChange={(_e, v) => set("issuer", v)} isDisabled={isDisabled} style={{ maxWidth: "20rem" }}>
          <FormSelectOption value="" label={t("tls_policy.proto_default")} />
          <FormSelectOption value="local_certs" label={t("global_opts.issuer_local_certs")} />
          <FormSelectOption value="internal" label={t("global_opts.issuer_internal")} />
          <FormSelectOption value="acme" label={t("global_opts.issuer_acme")} />
          {value.customIssuer && <FormSelectOption value="custom" label={`${t("tls_policy.lifetime_preset_custom")}: ${value.customIssuer}`} />}
        </FormSelect>
      </FormGroup>

      <FormGroup label={t("global_opts.key_type")} fieldId="go-key-type">
        <FormSelect id="go-key-type" value={value.keyType} onChange={(_e, v) => set("keyType", v)} isDisabled={isDisabled} style={{ maxWidth: "20rem" }}>
          <FormSelectOption value="" label={t("tls_policy.proto_default")} />
          {KEY_TYPES.map(k => <FormSelectOption key={k} value={k} label={k} />)}
          {unknownKeyType && <FormSelectOption value={value.keyType} label={value.keyType} />}
        </FormSelect>
      </FormGroup>

      <FormGroup label={t("global_opts.preferred_chains")} fieldId="go-chains">
        <FormSelect id="go-chains" value={value.chainsMode} onChange={(_e, v) => set("chainsMode", v as GlobalTlsValues["chainsMode"])} isDisabled={isDisabled} style={{ maxWidth: "20rem" }}>
          <FormSelectOption value="" label={t("tls_policy.proto_default")} />
          <FormSelectOption value="smallest" label={t("global_opts.preferred_chains_smallest")} />
          <FormSelectOption value="root_common_name" label={t("global_opts.preferred_chains_root")} />
          <FormSelectOption value="any_common_name" label={t("global_opts.preferred_chains_any")} />
        </FormSelect>
        {(value.chainsMode === "root_common_name" || value.chainsMode === "any_common_name") && (
          <>
            <TextInput
              id="go-chains-names"
              aria-label={t("global_opts.preferred_chains_names")}
              value={value.chainsNames}
              onChange={(_e, v) => set("chainsNames", v)}
              placeholder="ISRG Root X1"
              isDisabled={isDisabled}
              style={{ marginTop: "0.4rem" }}
            />
            <FormHelperText><HelperText><HelperTextItem>{t("global_opts.preferred_chains_names_help")}</HelperTextItem></HelperText></FormHelperText>
          </>
        )}
      </FormGroup>

      <FormGroup label={t("global_opts.default_sni")} fieldId="go-default-sni">
        <TextInput id="go-default-sni" value={value.defaultSni} onChange={(_e, v) => set("defaultSni", v)} placeholder="example.com" isDisabled={isDisabled} />
        <FormHelperText><HelperText><HelperTextItem>{t("global_opts.default_sni_help")}</HelperTextItem></HelperText></FormHelperText>
      </FormGroup>

      <FormGroup label={t("global_opts.default_bind")} fieldId="go-default-bind">
        <TextInput id="go-default-bind" value={value.defaultBind} onChange={(_e, v) => set("defaultBind", v)} placeholder="127.0.0.1" isDisabled={isDisabled} />
        <FormHelperText><HelperText><HelperTextItem>{t("global_opts.default_bind_help")}</HelperTextItem></HelperText></FormHelperText>
      </FormGroup>

      <FormGroup fieldId="go-ocsp-off">
        <Checkbox id="go-ocsp-off" label={t("global_opts.ocsp_stapling_off")} isChecked={value.ocspStaplingOff} onChange={(_e, c) => set("ocspStaplingOff", c)} isDisabled={isDisabled} />
      </FormGroup>
    </>
  );
}
