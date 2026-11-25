import { Label, Tooltip } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { hasNestedBlocks } from "../api/siteTree";
import type { ProxyEntry } from "../api";

/** True when the site's block has a `route` or nested `handle` blocks, which the form fields do not show (#348). */
export function hasRawBlocks(proxy: Pick<ProxyEntry, "siteText">): boolean {
  return !!proxy.siteText && hasNestedBlocks(proxy.siteText);
}

/** The read-only mark of #348, next to the other badges of a site. */
export function RawBlocksBadge({ proxy }: { proxy: Pick<ProxyEntry, "siteText"> }) {
  const { t } = useTranslation();
  if (!hasRawBlocks(proxy)) return null;
  return (
    <Tooltip content={t("proxies.raw_blocks_help")}>
      <Label isCompact color="orange" variant="outline" data-testid="raw-blocks-badge">{t("proxies.indicator_raw_blocks")}</Label>
    </Tooltip>
  );
}
