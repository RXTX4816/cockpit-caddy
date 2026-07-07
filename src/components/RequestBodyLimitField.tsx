import { FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";

interface Props {
  value: string;
  onChange: (v: string) => void;
  isDisabled?: boolean;
  idPrefix: string;
}

/** Maximum request body size in bytes (#154) — a single field shared by every handler
 *  type that actually reads the request body (reverse_proxy, file_server, php_fastcgi). */
export function RequestBodyLimitField({ value, onChange, isDisabled, idPrefix }: Props) {
  const { t } = useTranslation();
  return (
    <FormGroup label={t("request_body.field_label")} fieldId={`${idPrefix}-request-body-max-size`}>
      <TextInput
        id={`${idPrefix}-request-body-max-size`}
        type="number"
        value={value}
        onChange={(_e, v) => onChange(v)}
        placeholder={t("request_body.field_placeholder")}
        isDisabled={isDisabled}
      />
      <FormHelperText>
        <HelperText><HelperTextItem>{t("request_body.field_help")}</HelperTextItem></HelperText>
      </FormHelperText>
    </FormGroup>
  );
}
