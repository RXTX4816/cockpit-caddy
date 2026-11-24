import { useEffect, useState } from "react";
import { Alert, FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { externalHostList, listDnsProviders, readDnsEnvNames, readGlobalOptions } from "../api";
import type { DnsChallengeConfig } from "../api";
import { DnsChallengeFields, dnsDraftFromConfig, dnsDraftToConfig, validateDnsDraft, type DnsDraft } from "./DnsChallengeFields";

/** A site's DNS challenge (#289): the global acme_dns provider, or one of its own. */
export type SiteDnsMode = "inherit" | "override";

export interface SiteDns {
  mode: SiteDnsMode;
  setMode: (m: SiteDnsMode) => void;
  draft: DnsDraft;
  setDraft: (d: DnsDraft) => void;
  /** Installed dns.providers.* modules; null while loading. */
  providers: string[] | null;
  envNames: string[];
  /** The global acme_dns provider, or undefined when none is set. */
  globalProvider?: string;
  /** The i18n key of the first problem for this site's host, or null. `acme`: automatic HTTPS is chosen. */
  error: (host: string | undefined, acme?: boolean) => string | null;
  /** The config to save on the site and the env-file changes for its credentials. Without
   *  automatic HTTPS the site has no override, and its old variables go. */
  plan: (host: string | undefined, acme: boolean) => {
    config: DnsChallengeConfig | undefined;
    secrets: { set: Record<string, string>; remove: string[] };
  };
}

/** The env-var site part: the first name of the host field, as written. */
const siteName = (host: string | undefined) => externalHostList(host)[0] ?? "";

/**
 * State for a site dialog's DNS challenge field. `initial` is the site's saved override;
 * `active` (automatic HTTPS chosen) loads the provider modules and the env file names.
 */
export function useSiteDns(initial: DnsChallengeConfig | undefined, active: boolean): SiteDns {
  const [mode, setMode] = useState<SiteDnsMode>(initial ? "override" : "inherit");
  const [draft, setDraft] = useState<DnsDraft>(() => dnsDraftFromConfig(initial));
  const [providers, setProviders] = useState<string[] | null>(null);
  const [envNames, setEnvNames] = useState<string[]>([]);
  const [globalProvider, setGlobalProvider] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active || loaded) return;
    setLoaded(true);
    void listDnsProviders().then(setProviders).catch(() => setProviders([]));
    void readDnsEnvNames().then(setEnvNames).catch(() => {});
    void readGlobalOptions().then(o => setGlobalProvider(o.acmeDns?.provider)).catch(() => {});
  }, [active, loaded]);

  const override = mode === "override";
  return {
    mode, setMode, draft, setDraft, providers, envNames, globalProvider,
    error: (host, acme = true) => {
      if (!override || !acme) return null;
      if (!draft.provider) return "dns.validation_provider";
      return validateDnsDraft(draft, envNames, siteName(host));
    },
    plan: (host, acme) => {
      const { config, set, remove } = dnsDraftToConfig(override && acme ? draft : dnsDraftFromConfig(undefined), initial, siteName(host));
      return { config, secrets: { set, remove } };
    },
  };
}

interface Props {
  id: string;
  dns: SiteDns;
  host: string | undefined;
  isDisabled?: boolean;
}

/** The "DNS challenge" select under automatic HTTPS, with the provider fields for an override. */
export function SiteDnsChallengeField({ id, dns, host, isDisabled }: Props) {
  const { t } = useTranslation();
  const wildcard = externalHostList(host).some(h => h.startsWith("*."));
  const inheritLabel = dns.globalProvider
    ? t("dns.site_inherit", { provider: dns.globalProvider })
    : t("dns.site_inherit_none");
  const error = dns.error(host);
  return (
    <FormGroup label={t("dns.site_label")} fieldId={id} style={{ marginTop: "0.6rem" }}>
      <FormSelect id={id} value={dns.mode} onChange={(_e, v) => dns.setMode(v as SiteDnsMode)} isDisabled={isDisabled} aria-label={t("dns.site_label")}>
        <FormSelectOption value="inherit" label={inheritLabel} />
        <FormSelectOption value="override" label={t("dns.site_override")} />
      </FormSelect>
      <FormHelperText>
        <HelperText>
          <HelperTextItem>{dns.mode === "override" ? t("dns.site_override_help") : t("dns.site_inherit_help")}</HelperTextItem>
        </HelperText>
      </FormHelperText>
      {wildcard && dns.mode === "inherit" && !dns.globalProvider && (
        <Alert variant="warning" isInline isPlain title={t("dns.site_wildcard_warning")} data-testid={`${id}-wildcard-warning`} style={{ marginTop: "0.4rem" }} />
      )}
      {dns.mode === "override" && (
        <div style={{ marginTop: "0.6rem" }}>
          <DnsChallengeFields
            idPrefix={id}
            providers={dns.providers}
            envNames={dns.envNames}
            value={dns.draft}
            onChange={dns.setDraft}
            site={externalHostList(host)[0]}
            isDisabled={isDisabled}
          />
          {error === "dns.validation_provider" && dns.providers?.length ? (
            <HelperText><HelperTextItem variant="error" id={`${id}-provider-error`}>{t(error)}</HelperTextItem></HelperText>
          ) : null}
        </div>
      )}
    </FormGroup>
  );
}
