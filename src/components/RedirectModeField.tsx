import { Button, Checkbox, FormGroup, FormHelperText, HelperText, HelperTextItem } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";

export const REDIRECT_CODES = [301, 302, 307, 308] as const;

/** A status code, or `html`: a page that redirects in the browser, which keeps the URL fragment (#338). */
export type RedirectMode = typeof REDIRECT_CODES[number] | "html";

const KEEP_PATH = "{uri}";

/** The target without the `{uri}` the "keep the path and query" checkbox adds, and whether it was there. */
export function splitRedirectTarget(to: string): { to: string; keepPath: boolean } {
  return to.endsWith(KEEP_PATH) ? { to: to.slice(0, -KEEP_PATH.length), keepPath: true } : { to, keepPath: false };
}

/** The target to save: `{uri}` goes after it, with no slash in between since the URI starts with one. */
export function joinRedirectTarget(to: string, keepPath: boolean): string {
  const target = to.trim();
  if (!keepPath || target.includes(KEEP_PATH)) return target;
  return `${target.replace(/\/+$/, "")}${KEEP_PATH}`;
}

export function redirectModeOf(r: { code: 301 | 302 | 307 | 308; html?: boolean } | undefined): RedirectMode {
  return r?.html ? "html" : r?.code ?? 308;
}

interface Props {
  idPrefix: string;
  mode: RedirectMode;
  onModeChange: (m: RedirectMode) => void;
  keepPath: boolean;
  onKeepPathChange: (v: boolean) => void;
  isDisabled?: boolean;
}

export function RedirectModeField({ idPrefix, mode, onModeChange, keepPath, onKeepPathChange, isDisabled }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <FormGroup label={t("add_redirect.field_code")} fieldId={`${idPrefix}-code`} isRequired>
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {[...REDIRECT_CODES, "html" as const].map(m => (
            <Button key={m} variant={mode === m ? "primary" : "secondary"} size="sm" onClick={() => onModeChange(m)} isDisabled={isDisabled}>
              {t(`add_redirect.code_${m}`)}
            </Button>
          ))}
        </div>
        {mode === "html" && (
          <FormHelperText><HelperText><HelperTextItem>{t("add_redirect.code_html_help")}</HelperTextItem></HelperText></FormHelperText>
        )}
      </FormGroup>
      <FormGroup fieldId={`${idPrefix}-keep-path`}>
        <Checkbox
          id={`${idPrefix}-keep-path`}
          label={t("add_redirect.keep_path")}
          description={t("add_redirect.keep_path_help")}
          isChecked={keepPath}
          onChange={(_e, v) => onKeepPathChange(v)}
          isDisabled={isDisabled}
        />
      </FormGroup>
    </>
  );
}
