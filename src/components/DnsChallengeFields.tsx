import { Button, FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem, Label, TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { DNS_MODULES_DOCS, DNS_PROVIDER_PRESETS, dnsEnvVarName, isSiteDnsVar } from "../api";
import type { DnsChallengeConfig } from "../api";
import { Notice } from "./Notice";

/** One credential as edited: the provider option, a new value (empty = keep), the variable it lives in. */
export interface DnsCredentialRow {
  key: string;
  value: string;
  /** The variable the loaded config points at; kept while the option name doesn't change. */
  envName?: string;
  loadedKey?: string;
}

export interface DnsDraft {
  provider: string;
  rows: DnsCredentialRow[];
  /** Literal values of a hand-written config, written back unchanged (never shown). */
  literal?: Record<string, string>;
}

export function dnsDraftFromConfig(cfg: DnsChallengeConfig | undefined): DnsDraft {
  return {
    provider: cfg?.provider ?? "",
    rows: Object.entries(cfg?.credentials ?? {}).map(([key, envName]) => ({ key, value: "", envName, loadedKey: key })),
    literal: cfg?.literal,
  };
}

const OPTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variable a row writes to: the loaded one while the option keeps its name, else ours.
 * A per-site variable named for another host (the site was renamed) moves to this host's
 * name, so a later site with the old name can't share it (#289).
 */
function rowEnvName(row: DnsCredentialRow, site?: string): string {
  const key = row.key.trim();
  const ours = dnsEnvVarName(key, site);
  if (!row.envName || row.loadedKey !== key) return ours;
  return site && isSiteDnsVar(row.envName) && row.envName !== ours ? ours : row.envName;
}

/**
 * The config to save plus the env-file changes: new values to set, and the plugin's own
 * variables (CADDY_DNS_…) the previous config used and this one doesn't.
 */
export function dnsDraftToConfig(
  draft: DnsDraft, previous: DnsChallengeConfig | undefined, site?: string,
): { config: DnsChallengeConfig | undefined; set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  let config: DnsChallengeConfig | undefined;
  if (draft.provider) {
    const credentials: Record<string, string> = {};
    for (const row of draft.rows) {
      const key = row.key.trim();
      if (!key) continue;
      const env = rowEnvName(row, site);
      credentials[key] = env;
      if (row.value) set[env] = row.value;
    }
    const literal = Object.fromEntries(Object.entries(draft.literal ?? {}).filter(([k]) => !k || !(k in credentials)));
    config = { provider: draft.provider, credentials, ...(Object.keys(literal).length ? { literal } : {}) };
  }
  const used = new Set(Object.values(config?.credentials ?? {}));
  const remove = Object.values(previous?.credentials ?? {}).filter(n => n.startsWith("CADDY_DNS_") && !used.has(n));
  return { config, set, remove };
}

/** The i18n key of the first problem, or null. */
export function validateDnsDraft(draft: DnsDraft, envNames: string[], site?: string): string | null {
  if (!draft.provider) return null;
  const seen = new Set<string>();
  for (const row of draft.rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!OPTION_NAME.test(key)) return "dns.validation_option";
    if (seen.has(key)) return "dns.validation_duplicate";
    seen.add(key);
    if (!row.value && !envNames.includes(rowEnvName(row, site))) return "dns.validation_value";
  }
  return null;
}

interface Props {
  idPrefix: string;
  /** Installed dns.providers.* modules; null while loading. */
  providers: string[] | null;
  /** Variables already in the env file (to show "set"). */
  envNames: string[];
  value: DnsDraft;
  onChange: (d: DnsDraft) => void;
  site?: string;
  isDisabled?: boolean;
}

/** Provider select and credential fields; without any DNS module, the explanation instead. */
export function DnsChallengeFields({ idPrefix, providers, envNames, value, onChange, site, isDisabled }: Props) {
  const { t } = useTranslation();
  if (providers && !providers.length && !value.provider) {
    return (
      <Notice variant="info" isPlain title={t("dns.no_modules_title")} data-testid={`${idPrefix}-no-modules`}>
        <p>{t("dns.no_modules_body")}</p>
        <a href={DNS_MODULES_DOCS} target="_blank" rel="noopener noreferrer">{t("dns.no_modules_link")}</a>
      </Notice>
    );
  }
  const list = providers ?? [];
  const options = value.provider && !list.includes(value.provider) ? [value.provider, ...list] : list;
  const error = validateDnsDraft(value, envNames, site);

  function setProvider(provider: string) {
    // Prefill the option names of a known provider while nothing has been entered yet.
    const empty = value.rows.every(r => !r.key.trim() && !r.value);
    const preset = DNS_PROVIDER_PRESETS[provider];
    onChange({ ...value, provider, rows: empty && preset ? preset.map(key => ({ key, value: "" })) : value.rows });
  }
  const setRow = (i: number, patch: Partial<DnsCredentialRow>) =>
    onChange({ ...value, rows: value.rows.map((r, j) => j === i ? { ...r, ...patch } : r) });

  return (
    <>
      <FormGroup label={t("dns.provider")} fieldId={`${idPrefix}-provider`}>
        <FormSelect id={`${idPrefix}-provider`} value={value.provider} onChange={(_e, v) => setProvider(v)} isDisabled={isDisabled}>
          <FormSelectOption value="" label={t("dns.provider_choose")} isPlaceholder />
          {options.map(p => <FormSelectOption key={p} value={p} label={p} />)}
        </FormSelect>
      </FormGroup>
      {value.provider && (
        <FormGroup label={t("dns.credentials")} fieldId={`${idPrefix}-cred-key-0`} role="group">
          {value.rows.map((row, i) => {
            const isSet = !row.value && envNames.includes(rowEnvName(row, site));
            return (
              <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.4rem" }}>
                <TextInput
                  id={`${idPrefix}-cred-key-${i}`}
                  aria-label={t("dns.option_name")}
                  value={row.key}
                  onChange={(_e, v) => setRow(i, { key: v })}
                  placeholder="api_token"
                  isDisabled={isDisabled}
                  style={{ flex: "1 1 10rem" }}
                />
                <TextInput
                  id={`${idPrefix}-cred-value-${i}`}
                  aria-label={t("dns.option_value")}
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  onChange={(_e, v) => setRow(i, { value: v })}
                  placeholder={isSet ? t("dns.value_keep") : ""}
                  isDisabled={isDisabled}
                  style={{ flex: "2 1 14rem" }}
                />
                {isSet && <Label isCompact color="green" data-testid={`${idPrefix}-cred-set-${i}`}>{t("dns.value_set")}</Label>}
                <Button variant="plain" isDanger size="sm" aria-label={t("dns.remove_option")} isDisabled={isDisabled}
                  onClick={() => onChange({ ...value, rows: value.rows.filter((_, j) => j !== i) })}>×</Button>
              </div>
            );
          })}
          <Button variant="link" isInline size="sm" isDisabled={isDisabled}
            onClick={() => onChange({ ...value, rows: [...value.rows, { key: "", value: "" }] })}>
            {t("dns.add_option")}
          </Button>
          <FormHelperText>
            <HelperText>
              {error
                ? <HelperTextItem variant="error" id={`${idPrefix}-error`}>{t(error)}</HelperTextItem>
                : <HelperTextItem>{t("dns.credentials_help")}</HelperTextItem>}
            </HelperText>
          </FormHelperText>
        </FormGroup>
      )}
    </>
  );
}
