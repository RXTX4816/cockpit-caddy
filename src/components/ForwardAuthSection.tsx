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
import type { ForwardAuthConfig } from "../api";

interface Props {
  value: ForwardAuthConfig | undefined;
  onChange: (v: ForwardAuthConfig | undefined) => void;
  isDisabled?: boolean;
  uriError?: string;
  urlError?: string;
}

function empty(): ForwardAuthConfig {
  return { upstreamUrl: "", uri: "/", copyHeaders: [] };
}

function headersToString(headers: string[]): string {
  return headers.join(", ");
}

function parseHeaders(raw: string): string[] {
  return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

export function validateForwardAuth(fa: ForwardAuthConfig | undefined): string | null {
  if (!fa) return null;
  if (fa.upstreamUrl.trim() && !fa.uri?.trim()) return "forward_auth.validation_uri_required";
  return null;
}

export function ForwardAuthSection({ value, onChange, isDisabled, uriError, urlError }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(!!value);
  const [headersInput, setHeadersInput] = useState(() => headersToString(value?.copyHeaders ?? []));

  const enabled = !!value;

  function enable() {
    onChange(empty());
    setExpanded(true);
  }

  function disable() {
    onChange(undefined);
    setExpanded(false);
  }

  function update(patch: Partial<ForwardAuthConfig>) {
    if (!value) return;
    onChange({ ...value, ...patch });
  }

  const toggleLabel = enabled
    ? t("forward_auth.section_title_on")
    : t("forward_auth.section_title");

  return (
    <ExpandableSection
      toggleText={toggleLabel}
      isIndented
      isExpanded={expanded}
      onToggle={(_e, v) => setExpanded(v)}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", paddingTop: "0.25rem" }}>
        {!enabled ? (
          <Button variant="link" isInline onClick={enable} isDisabled={isDisabled}>
            {t("forward_auth.enable_button")}
          </Button>
        ) : (
          <>
            <FormGroup label={t("forward_auth.field_url")} fieldId="fa-url" isRequired>
              <TextInput
                id="fa-url"
                value={value.upstreamUrl}
                onChange={(_e, v) => update({ upstreamUrl: v })}
                placeholder="http://localhost:9091"
                validated={urlError ? "error" : "default"}
                isDisabled={isDisabled}
              />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant={urlError ? "error" : "default"}>
                    {urlError ? t(urlError) : t("forward_auth.field_url_help")}
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>

            <FormGroup label={t("forward_auth.field_uri")} fieldId="fa-uri" isRequired>
              <TextInput
                id="fa-uri"
                value={value.uri ?? ""}
                onChange={(_e, v) => update({ uri: v || undefined })}
                placeholder="/api/authz/forward-auth"
                validated={uriError ? "error" : "default"}
                isDisabled={isDisabled}
              />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant={uriError ? "error" : "default"}>
                    {uriError ? t(uriError) : t("forward_auth.field_uri_help")}
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>

            <FormGroup label={t("forward_auth.field_copy_headers")} fieldId="fa-headers">
              <TextInput
                id="fa-headers"
                value={headersInput}
                onChange={(_e, v) => {
                  setHeadersInput(v);
                  update({ copyHeaders: parseHeaders(v) });
                }}
                placeholder="Remote-User, Remote-Groups, Remote-Name"
                isDisabled={isDisabled}
              />
              <FormHelperText>
                <HelperText><HelperTextItem>{t("forward_auth.field_copy_headers_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            </FormGroup>

            <div>
              <Button variant="link" isInline isDanger onClick={disable} isDisabled={isDisabled}>
                {t("forward_auth.disable_button")}
              </Button>
            </div>
          </>
        )}
      </div>
    </ExpandableSection>
  );
}
