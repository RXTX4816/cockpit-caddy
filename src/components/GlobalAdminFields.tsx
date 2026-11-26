import { Checkbox, FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput } from "@patternfly/react-core";
import { Notice } from "./Notice";
import { useTranslation } from "react-i18next";
import type { GlobalOptions } from "../api";

/** The form's view of the `admin` option of #330. */
export interface GlobalAdminValues {
  /** `admin off` read from the file: kept as written, not offered (outside the v1 scope of #330). */
  off: boolean;
  address: string;
  origins: string;
  enforceOrigin: boolean;
}

export function globalAdminToValues(o: GlobalOptions): GlobalAdminValues {
  return {
    off: o.adminOff ?? false,
    address: o.adminAddress ?? "",
    origins: o.adminOrigins?.join(" ") ?? "",
    enforceOrigin: o.adminEnforceOrigin ?? false,
  };
}

export function globalAdminFromValues(v: GlobalAdminValues): Pick<GlobalOptions, "adminOff" | "adminAddress" | "adminOrigins" | "adminEnforceOrigin"> {
  if (v.off) return { adminOff: true };
  return {
    adminAddress: v.address.trim() || undefined,
    adminOrigins: v.origins.trim() ? v.origins.trim().split(/\s+/) : undefined,
    adminEnforceOrigin: v.enforceOrigin || undefined,
  };
}

interface Props {
  value: GlobalAdminValues;
  onChange: (v: GlobalAdminValues) => void;
  isDisabled?: boolean;
  /** Caddy isn't the local service: the plugin doesn't own its Caddyfile, so this is read-only. */
  isReadOnly?: boolean;
}

export function GlobalAdminFields({ value, onChange, isDisabled, isReadOnly }: Props) {
  const { t } = useTranslation();
  const set = <K extends keyof GlobalAdminValues>(key: K, v: GlobalAdminValues[K]) => onChange({ ...value, [key]: v });
  const off = isDisabled || isReadOnly || value.off;

  return (
    <>
      {isReadOnly && <Notice variant="info" title={t("global_opts.admin_read_only")} />}
      {value.off && !isReadOnly && <Notice variant="warning" title={t("global_opts.admin_off_kept")} />}

      <FormGroup label={t("global_opts.admin_address")} fieldId="go-admin-address">
        <TextInput id="go-admin-address" value={value.address} onChange={(_e, v) => set("address", v)} placeholder="localhost:2019" isDisabled={off} />
        <FormHelperText><HelperText><HelperTextItem>{t("global_opts.admin_address_help")}</HelperTextItem></HelperText></FormHelperText>
      </FormGroup>

      <FormGroup label={t("global_opts.admin_origins")} fieldId="go-admin-origins">
        <TextInput id="go-admin-origins" value={value.origins} onChange={(_e, v) => set("origins", v)} placeholder="localhost:2019" isDisabled={off} />
        <FormHelperText><HelperText><HelperTextItem>{t("global_opts.admin_origins_help")}</HelperTextItem></HelperText></FormHelperText>
      </FormGroup>

      <FormGroup fieldId="go-admin-enforce">
        <Checkbox id="go-admin-enforce" label={t("global_opts.admin_enforce_origin")} isChecked={value.enforceOrigin} onChange={(_e, c) => set("enforceOrigin", c)} isDisabled={off} />
      </FormGroup>
    </>
  );
}
