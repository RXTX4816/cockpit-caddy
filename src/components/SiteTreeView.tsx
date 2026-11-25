import { Label } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { childNodes, nodeHandlers, parseSiteTree, type SiteTree, type TreeItem, type TreeNode } from "../api/siteTree";

const KIND_COLORS = { route: "purple", handle: "blue", handle_path: "teal", opaque: "grey" } as const;

/** `@name` definitions on one line (`@api path /api/*`) or in a block, by name, within one body. */
export function matcherDefinitions(items: TreeItem[]): Record<string, string> {
  const defs: Record<string, string> = {};
  for (const it of items) {
    if ("line" in it) {
      const m = it.line.trim().match(/^@([\w-]+)\s+(\S.*)$/);
      if (m) defs[m[1]] = m[2];
    } else if (it.node.kind === "opaque") {
      const m = it.node.header.trim().match(/^@([\w-]+)\s*\{/);
      if (m) defs[m[1]] = nodeHandlers(it.node).join("; ");
    }
  }
  return defs;
}

/** What a matcher means: the definition of an `@name` found in this body or one around it, else the text itself. */
export function describeMatcher(matcher: string, scopes: Array<Record<string, string>>): string {
  const name = matcher.match(/^@([\w-]+)$/)?.[1];
  if (!name) return matcher;
  for (const defs of scopes) if (defs[name]) return `${matcher}: ${defs[name]}`;
  return matcher;
}

const listStyle = { listStyle: "none", margin: 0, paddingLeft: "1.25rem" } as const;

function NodeView({ node, scopes }: { node: TreeNode; scopes: Array<Record<string, string>> }) {
  const { t } = useTranslation();
  const own = [matcherDefinitions(node.items), ...scopes];
  const handlers = node.kind === "opaque" ? node.items.flatMap(it => "line" in it ? [it.line.trim()] : []).filter(Boolean) : nodeHandlers(node);
  const children = node.kind === "opaque" ? [] : childNodes(node.items);
  const kindLabel = node.kind === "opaque" ? t("tree.kind_opaque") : node.kind;
  const summary = node.kind === "opaque" ? node.header.trim() : node.matcher ? describeMatcher(node.matcher, scopes) : t("tree.no_matcher");
  return (
    <li role="treeitem" aria-expanded="true" aria-label={`${kindLabel} ${summary}`} style={{ marginTop: "0.4rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <Label isCompact color={KIND_COLORS[node.kind]}>{kindLabel}</Label>
        <code>{summary}</code>
      </div>
      {handlers.length > 0 && (
        <ul style={{ ...listStyle, color: "var(--pf-t--global--text--color--subtle)" }} aria-label={t("tree.handlers")}>
          {handlers.map((h, i) => <li key={i}><code style={{ fontSize: "0.85rem" }}>{h}</code></li>)}
        </ul>
      )}
      {children.length > 0 && (
        <ul role="group" style={listStyle}>
          {children.map((c, i) => <NodeView key={i} node={c} scopes={own} />)}
        </ul>
      )}
    </li>
  );
}

/** The route and handle blocks of a site, read-only (#349). */
export function SiteTreeView({ tree }: { tree: SiteTree }) {
  const { t } = useTranslation();
  const scopes = [matcherDefinitions(tree.items)];
  const roots = childNodes(tree.items);
  return (
    <ul role="tree" aria-label={t("tree.aria_label")} style={{ ...listStyle, paddingLeft: 0 }}>
      <li role="treeitem" aria-expanded="true" aria-label={tree.header.trim()}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
          <Label isCompact color="blue" variant="outline">{t("tree.site")}</Label>
          <code>{tree.header.trim().replace(/\s*\{\s*$/, "")}</code>
        </div>
        <ul role="group" style={listStyle}>
          {roots.map((n, i) => <NodeView key={i} node={n} scopes={scopes} />)}
        </ul>
      </li>
    </ul>
  );
}

/** The Tree tab: the tree of a site's text, or a note when the text cannot be read as one. */
export function SiteTreeTab({ siteText }: { siteText: string }) {
  const { t } = useTranslation();
  const tree = parseSiteTree(siteText);
  if (!tree) return <p>{t("tree.unreadable")}</p>;
  return (
    <>
      <p style={{ margin: 0, color: "var(--pf-t--global--text--color--subtle)" }}>{t("tree.read_only_help")}</p>
      <SiteTreeView tree={tree} />
    </>
  );
}
