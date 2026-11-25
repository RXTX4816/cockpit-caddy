import { Label, Tooltip } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { hasNestedBlocks, rawOnlyBlocks } from "../api/siteTree";
import type { ProxyEntry } from "../api";

/**
 * True when the site's block has a `route` or nested `handle` blocks that only the raw editor can
 * change (#348): the form fields do not show them, and the Tree tab edits the ones it understands (#351).
 */
export function hasRawBlocks(proxy: Pick<ProxyEntry, "siteText">): boolean {
  return rawBlocksOf(proxy).length > 0;
}

/** What is still raw-only: the opening lines of the blocks the tree shows as written. */
export function rawBlocksOf(proxy: Pick<ProxyEntry, "siteText">): string[] {
  return proxy.siteText && hasNestedBlocks(proxy.siteText) ? rawOnlyBlocks(proxy.siteText) : [];
}

/** The read-only mark of #348, next to the other badges of a site. */
export function RawBlocksBadge({ proxy }: { proxy: Pick<ProxyEntry, "siteText"> }) {
  const { t } = useTranslation();
  const blocks = rawBlocksOf(proxy);
  if (!blocks.length) return null;
  const names = [...new Set(blocks)].slice(0, 5).join(", ");
  return (
    <Tooltip content={`${t("proxies.raw_blocks_help")} ${t("proxies.raw_blocks_names", { blocks: names })}`}>
      <Label isCompact color="orange" variant="outline" data-testid="raw-blocks-badge">{t("proxies.indicator_raw_blocks")}</Label>
    </Tooltip>
  );
}
