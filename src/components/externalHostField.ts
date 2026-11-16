import type { TFunction } from "i18next";
import { validateExternalHost } from "../api";

/** The host-field error the proxy dialogs show for a typed host list (#208), if any. */
export function externalHostFieldError(
  value: string,
  t: TFunction,
): string | undefined {
  const err = validateExternalHost(value);
  if (!err) return undefined;
  switch (err.kind) {
    case "empty_entry": return t("add_proxy.validation_ext_host_empty_entry");
    case "space": return t("add_proxy.validation_ext_host_space", { host: err.host });
    case "scheme_or_port": return t("add_proxy.validation_ext_host_scheme_or_port", { host: err.host });
    case "duplicate": return t("add_proxy.validation_ext_host_duplicate", { host: err.host });
  }
}
