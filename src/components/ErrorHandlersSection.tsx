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
import type { ErrorHandlerConfig, ErrorMatchType, ErrorHandlerType } from "../api";
import { SectionActions } from "./SectionActions";

interface Props {
  value: ErrorHandlerConfig[];
  onChange: (v: ErrorHandlerConfig[]) => void;
  isDisabled?: boolean;
}

const MATCH_TYPES: ErrorMatchType[] = ["specific", "4xx", "5xx", "all"];
const HANDLER_TYPES: ErrorHandlerType[] = ["respond", "redirect", "static"];
const REDIRECT_CODES = [301, 302, 307, 308] as const;

function emptyHandler(): ErrorHandlerConfig {
  return { matchType: "specific", codes: [404], type: "respond", body: "" };
}

function codesInputValue(h: ErrorHandlerConfig): string {
  return h.codes?.join(", ") ?? "";
}

function parseCodes(raw: string): number[] {
  return raw.split(/[\s,]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 100 && n <= 599);
}

export function ErrorHandlersSection({ value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(value.length > 0);

  function update(idx: number, patch: Partial<ErrorHandlerConfig>) {
    onChange(value.map((h, i) => i === idx ? { ...h, ...patch } : h));
  }

  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...value, emptyHandler()]);
    setExpanded(true);
  }

  const toggleLabel = value.length > 0
    ? t("error_handler.section_title_on", { count: value.length })
    : t("error_handler.section_title");

  return (
    <ExpandableSection
      toggleText={toggleLabel}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <SectionActions
        onClear={() => { onChange([]); setExpanded(false); }}
        isDisabled={isDisabled}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {value.map((handler, idx) => (
          <div key={idx} style={{
            border: "1px solid var(--pf-t--global--border--color--default)",
            borderRadius: "var(--pf-t--global--border--radius--100, 4px)",
            padding: "0.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              {/* Match type */}
              <FormGroup label={t("error_handler.field_match")} fieldId={`eh-match-${idx}`} style={{ flex: "1 1 8rem" }}>
                <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                  {MATCH_TYPES.map(m => (
                    <Button
                      key={m}
                      variant={handler.matchType === m ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => update(idx, { matchType: m, codes: m === "specific" ? (handler.codes?.length ? handler.codes : [404]) : undefined })}
                      isDisabled={isDisabled}
                    >
                      {t(`error_handler.match_${m}`)}
                    </Button>
                  ))}
                </div>
              </FormGroup>

              <Button
                variant="plain"
                onClick={() => remove(idx)}
                isDisabled={isDisabled}
                aria-label={t("error_handler.remove_button")}
                style={{ marginLeft: "auto", alignSelf: "flex-start" }}
              >✕</Button>
            </div>

            {handler.matchType === "specific" && (
              <FormGroup label={t("error_handler.field_codes")} fieldId={`eh-codes-${idx}`}>
                <TextInput
                  id={`eh-codes-${idx}`}
                  value={codesInputValue(handler)}
                  onChange={(_e, v) => update(idx, { codes: parseCodes(v) })}
                  placeholder="404, 502, 503"
                  isDisabled={isDisabled}
                />
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("error_handler.field_codes_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              </FormGroup>
            )}

            {/* Handler type */}
            <FormGroup label={t("error_handler.field_type")} fieldId={`eh-type-${idx}`}>
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                {HANDLER_TYPES.map(tp => (
                  <Button
                    key={tp}
                    variant={handler.type === tp ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => update(idx, { type: tp })}
                    isDisabled={isDisabled}
                  >
                    {t(`error_handler.type_${tp}`)}
                  </Button>
                ))}
              </div>
            </FormGroup>

            {handler.type === "respond" && (
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <FormGroup label={t("error_handler.field_body")} fieldId={`eh-body-${idx}`} style={{ flex: "3 1 14rem" }}>
                  <TextInput
                    id={`eh-body-${idx}`}
                    value={handler.body ?? ""}
                    onChange={(_e, v) => update(idx, { body: v })}
                    placeholder={t("error_handler.field_body_placeholder")}
                    isDisabled={isDisabled}
                  />
                </FormGroup>
                <FormGroup label={t("error_handler.field_status_code")} fieldId={`eh-sc-${idx}`} style={{ flex: "1 1 6rem" }}>
                  <TextInput
                    id={`eh-sc-${idx}`}
                    type="number"
                    value={handler.statusCode != null ? String(handler.statusCode) : ""}
                    onChange={(_e, v) => update(idx, { statusCode: v ? parseInt(v, 10) : undefined })}
                    placeholder={t("error_handler.field_status_code_placeholder")}
                    isDisabled={isDisabled}
                  />
                </FormGroup>
              </div>
            )}

            {handler.type === "redirect" && (
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                <FormGroup label={t("error_handler.field_redirect_to")} fieldId={`eh-redir-${idx}`} style={{ flex: "3 1 14rem" }}>
                  <TextInput
                    id={`eh-redir-${idx}`}
                    value={handler.redirectTo ?? ""}
                    onChange={(_e, v) => update(idx, { redirectTo: v })}
                    placeholder="/error.html"
                    isDisabled={isDisabled}
                  />
                </FormGroup>
                <FormGroup label={t("error_handler.field_redirect_code")} fieldId={`eh-rcode-${idx}`} style={{ flex: "1 1 6rem" }}>
                  <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                    {REDIRECT_CODES.map(c => (
                      <Button
                        key={c}
                        variant={(handler.redirectCode ?? 302) === c ? "primary" : "secondary"}
                        size="sm"
                        onClick={() => update(idx, { redirectCode: c })}
                        isDisabled={isDisabled}
                      >
                        {c}
                      </Button>
                    ))}
                  </div>
                </FormGroup>
              </div>
            )}

            {handler.type === "static" && (
              <FormGroup label={t("error_handler.field_file_root")} fieldId={`eh-root-${idx}`}>
                <TextInput
                  id={`eh-root-${idx}`}
                  value={handler.filePath ?? ""}
                  onChange={(_e, v) => update(idx, { filePath: v })}
                  placeholder="/var/www/errors"
                  isDisabled={isDisabled}
                />
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("error_handler.field_file_root_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              </FormGroup>
            )}
          </div>
        ))}

        <div>
          <Button variant="link" isInline onClick={add} isDisabled={isDisabled}>
            + {t("error_handler.add_button")}
          </Button>
        </div>
      </div>
    </ExpandableSection>
  );
}
