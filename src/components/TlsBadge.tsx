import { Label } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ProxyEntry } from "../api";

/** The TLS chip in the site list (#246): who issues the certificate, not just "on". */
export function TlsBadge({ proxy }: { proxy: Pick<ProxyEntry, "tls" | "tlsIssuer" | "customTls"> }) {
  const { t } = useTranslation();
  if (!proxy.tls) return <Label isCompact color="grey" variant="outline">{t("proxies.tls_none")}</Label>;
  const key = proxy.customTls ? "proxies.tls_custom" : proxy.tlsIssuer === "acme" ? "proxies.tls_acme" : "proxies.tls_internal";
  return <Label isCompact color={proxy.tlsIssuer === "acme" && !proxy.customTls ? "green" : "blue"} variant="outline">{t(key)}</Label>;
}
