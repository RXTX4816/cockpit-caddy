import { useState } from "react";
import { Alert, Button, FormGroup, Label, TextInput } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import {
  childNodes, editNode, nodeAt, nodeHandlers, parseSiteTree, serializeSiteTree, validateNodeEdit,
  type NodePath, type SiteTree, type TreeItem, type TreeNode,
} from "../api/siteTree";

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

interface Select {
  selected?: NodePath;
  onSelect?: (p: NodePath) => void;
}

const samePath = (a: NodePath | undefined, b: NodePath) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

function NodeView({ node, scopes, path, selected, onSelect }: { node: TreeNode; scopes: Array<Record<string, string>>; path: NodePath } & Select) {
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
        {onSelect && node.kind !== "opaque" ? (
          <Button
            variant={samePath(selected, path) ? "primary" : "link"}
            isInline
            size="sm"
            aria-pressed={samePath(selected, path)}
            aria-label={`${t("tree.select")}: ${kindLabel} ${summary}`}
            onClick={() => onSelect(path)}
          ><code>{summary}</code></Button>
        ) : (
          <code>{summary}</code>
        )}
      </div>
      {handlers.length > 0 && (
        <ul style={{ ...listStyle, color: "var(--pf-t--global--text--color--subtle)" }} aria-label={t("tree.handlers")}>
          {handlers.map((h, i) => <li key={i}><code style={{ fontSize: "0.85rem" }}>{h}</code></li>)}
        </ul>
      )}
      {children.length > 0 && (
        <ul role="group" style={listStyle}>
          {children.map((c, i) => <NodeView key={i} node={c} scopes={own} path={[...path, i]} selected={selected} onSelect={onSelect} />)}
        </ul>
      )}
    </li>
  );
}

/** The route and handle blocks of a site, read-only (#349). */
export function SiteTreeView({ tree, selected, onSelect }: { tree: SiteTree } & Select) {
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
          {roots.map((n, i) => <NodeView key={i} node={n} scopes={scopes} path={[i]} selected={selected} onSelect={onSelect} />)}
        </ul>
      </li>
    </ul>
  );
}

/** The fields of the selected node: its matcher and the directives it holds itself (#350). */
function NodeFields({ node, edit, onChange, isDisabled }: {
  node: TreeNode;
  edit: { matcher?: string; handlers: Record<number, string> };
  onChange: (e: { matcher?: string; handlers: Record<number, string> }) => void;
  isDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const handlers = nodeHandlers(node);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <FormGroup label={t("tree.matcher_label")} fieldId="tree-matcher">
        <TextInput
          id="tree-matcher"
          value={edit.matcher ?? node.matcher}
          onChange={(_e, v) => onChange({ ...edit, matcher: v })}
          placeholder={node.kind === "handle_path" ? "/app/*" : "@name"}
          validated={validateNodeEdit({ matcher: edit.matcher }) ? "error" : "default"}
          isDisabled={isDisabled}
        />
        <div style={{ fontSize: "0.85rem", color: "var(--pf-t--global--text--color--subtle)" }}>{t("tree.matcher_help")}</div>
      </FormGroup>
      {handlers.map((h, i) => (
        <FormGroup key={i} label={`${t("tree.handler_label")} ${i + 1}`} fieldId={`tree-handler-${i}`}>
          <TextInput
            id={`tree-handler-${i}`}
            value={edit.handlers[i] ?? h}
            onChange={(_e, v) => onChange({ ...edit, handlers: { ...edit.handlers, [i]: v } })}
            validated={validateNodeEdit({ handlers: { [i]: edit.handlers[i] ?? h } }) ? "error" : "default"}
            isDisabled={isDisabled}
            style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}
          />
        </FormGroup>
      ))}
    </div>
  );
}

/**
 * The Tree tab: the tree of a site's text, with the matchers and directives of its nodes
 * editable when `onSave` is given (#350). The edits are applied to the text on Save; nodes the
 * form does not know stay read-only and every line not edited stays as written.
 */
export function SiteTreeTab({ siteText, onSave }: { siteText: string; onSave?: (text: string) => Promise<void> }) {
  const { t } = useTranslation();
  const original = parseSiteTree(siteText);
  const [tree, setTree] = useState<SiteTree | undefined>(original);
  const [selected, setSelected] = useState<NodePath | undefined>();
  const [edit, setEdit] = useState<{ matcher?: string; handlers: Record<number, string> }>({ handlers: {} });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!original || !tree) return <p>{t("tree.unreadable")}</p>;
  const node = selected ? nodeAt(tree, selected) : undefined;
  const invalid = !!validateNodeEdit(edit);

  function apply(): SiteTree {
    return selected && node && !invalid ? editNode(tree!, selected, edit) : tree!;
  }

  function choose(p: NodePath) {
    // Moving to another node keeps what was typed for this one.
    setTree(apply());
    setEdit({ handlers: {} });
    setSelected(p);
  }

  async function save() {
    const next = apply();
    setSaving(true);
    setError(null);
    try {
      await onSave?.(serializeSiteTree(next));
      setTree(next);
      setEdit({ handlers: {} });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const changed = serializeSiteTree(apply()) !== siteText;

  return (
    <>
      <p style={{ margin: 0, color: "var(--pf-t--global--text--color--subtle)" }}>{t(onSave ? "tree.edit_help" : "tree.read_only_help")}</p>
      <SiteTreeView tree={tree} selected={selected} onSelect={onSave ? choose : undefined} />
      {onSave && node && node.kind !== "opaque" && (
        <NodeFields key={selected?.join(".")} node={node} edit={edit} onChange={setEdit} isDisabled={saving} />
      )}
      {error && <Alert variant="danger" isInline title={error} />}
      {onSave && (
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button variant="primary" isDisabled={!changed || invalid || saving} isLoading={saving} onClick={() => void save()}>{t("tree.save")}</Button>
          <Button variant="link" isDisabled={!changed || saving} onClick={() => { setTree(original); setEdit({ handlers: {} }); setError(null); }}>{t("tree.discard")}</Button>
        </div>
      )}
    </>
  );
}
