import { FormGroup, FormHelperText, HelperText, HelperTextItem } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { SizeField } from "./SizeField";

interface Props {
  /** Bytes; empty means no limit (Caddy's default). */
  value: string;
  onChange: (v: string) => void;
  isDisabled?: boolean;
  idPrefix: string;
}

/** Maximum request body size (#154), entered as number + unit (#260) and stored in bytes. Shared by
 *  every handler type that actually reads the request body (reverse_proxy, file_server, php_fastcgi). */
export function RequestBodyLimitField({ value, onChange, isDisabled, idPrefix }: Props) {
  const { t } = useTranslation();
  return (
    <FormGroup label={t("request_body.field_label")} fieldId={`${idPrefix}-request-body-max-size`}>
      <SizeField id={`${idPrefix}-request-body-max-size`} value={value} onChange={onChange} isDisabled={isDisabled} />
      <FormHelperText>
        <HelperText><HelperTextItem>{t("request_body.field_help")}</HelperTextItem></HelperText>
      </FormHelperText>
    </FormGroup>
  );
}
