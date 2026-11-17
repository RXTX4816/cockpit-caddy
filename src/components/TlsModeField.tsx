import { Checkbox, FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { externalHostList, tlsSubjectHost } from "../api";
import type { ProxyEntry } from "../api";

/** Where a site's certificate comes from (#246). A certificate file set under the TLS
 *  settings section still overrides the issuer, as before. */
export type TlsMode = "acme" | "internal" | "off";

/** True when the host field holds at least one name a public CA can certify. */
export function hasPublicName(host: string | undefined): boolean {
  return externalHostList(host).some(h => !!tlsSubjectHost(h));
}

/** Automatic HTTPS for a public name; Caddy's internal CA for a bare port, an IP or a local name.
 *  A wildcard also defaults to the internal CA: ACME can only issue it through the DNS challenge. */
export function defaultTlsMode(host: string | undefined): TlsMode {
  if (externalHostList(host).some(h => h.startsWith("*."))) return "internal";
  return hasPublicName(host) ? "acme" : "internal";
}

export function tlsModeOf(p: Pick<ProxyEntry, "tls" | "tlsIssuer">): TlsMode {
  if (!p.tls) return "off";
  return p.tlsIssuer === "acme" ? "acme" : "internal";
}

export function tlsModeToEntry(mode: TlsMode, host: string | undefined): Pick<ProxyEntry, "tls" | "tlsIssuer"> {
  if (mode === "off") return { tls: false, tlsIssuer: undefined };
  return { tls: true, tlsIssuer: mode === "acme" && hasPublicName(host) ? "acme" : "internal" };
}

interface Props {
  id: string;
  value: TlsMode;
  onChange: (mode: TlsMode) => void;
  /** Whether the site's host field has a public name; ACME is unavailable without one. */
  publicName: boolean;
  isDisabled?: boolean;
  /** Per-site on-demand TLS (#253); the checkbox shows while TLS is on, when a handler is given. */
  onDemand?: boolean;
  onOnDemandChange?: (v: boolean) => void;
}

export function TlsModeField({ id, value, onChange, publicName, isDisabled, onDemand, onOnDemandChange }: Props) {
  const { t } = useTranslation();
  const help = value === "acme" ? t("tls_mode.acme_help")
    : value === "internal" ? (publicName ? t("tls_mode.internal_help") : t("tls_mode.acme_needs_name"))
    : t("tls_mode.off_help");
  return (
    <FormGroup label={t("tls_mode.label")} fieldId={id}>
      <FormSelect id={id} value={value} onChange={(_e, v) => onChange(v as TlsMode)} isDisabled={isDisabled} aria-label={t("tls_mode.label")}>
        <FormSelectOption value="acme" label={t("tls_mode.acme")} isDisabled={!publicName} />
        <FormSelectOption value="internal" label={t("tls_mode.internal")} />
        <FormSelectOption value="off" label={t("tls_mode.off")} />
      </FormSelect>
      <FormHelperText>
        <HelperText>
          <HelperTextItem>{help}</HelperTextItem>
        </HelperText>
      </FormHelperText>
      {value !== "off" && onOnDemandChange && (
        <Checkbox
          id={`${id}-on-demand`}
          label={t("tls_mode.on_demand")}
          description={t("tls_mode.on_demand_help")}
          isChecked={!!onDemand}
          onChange={(_e, v) => onOnDemandChange(v)}
          isDisabled={isDisabled}
          style={{ marginTop: "0.4rem" }}
        />
      )}
    </FormGroup>
  );
}
