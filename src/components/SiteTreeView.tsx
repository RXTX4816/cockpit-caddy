import { useState } from "react";
import { Alert, Button, FormGroup, FormHelperText, FormSelect, FormSelectOption, HelperText, HelperTextItem, Label, TextInput } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import {
  TREE_KINDS, addNode, childNodes, countDescendants, editNode, moveNode, nodeAt, nodeHandlers, orderMatters, parseSiteTree, removeNode,
  serializeSiteTree, validateNodeEdit,
  type NodePath, type SiteTree, type TreeItem, type TreeKind, type TreeNode,
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

/** True when somewhere below, outside a route, two or more blocks sit side by side: their order is Caddy's. */
function hasUnorderedSiblings(items: TreeItem[], inRoute: boolean): boolean {
  const nodes = childNodes(items);
  if (!inRoute && nodes.length > 1) return true;
  return nodes.some(n => n.kind !== "opaque" && hasUnorderedSiblings(n.items, n.kind === "route"));
}

interface Select {
  selected?: NodePath;
  onSelect?: (p: NodePath) => void;
  /** Move (-1 up, 1 down) and delete buttons next to every node (#351). */
  onMove?: (p: NodePath, direction: -1 | 1) => void;
  onRemove?: (p: NodePath) => void;
  /** While the selected node's fields hold an invalid edit, nothing else can be done (#362). */
  locked?: boolean;
}

const samePath = (a: NodePath | undefined, b: NodePath) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

function NodeView({ node, scopes, path, selected, onSelect, onMove, onRemove, locked, siblings, inRoute }: { node: TreeNode; scopes: Array<Record<string, string>>; path: NodePath; siblings: number; inRoute: boolean } & Select) {
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
            isDisabled={locked && !samePath(selected, path)}
            onClick={() => onSelect(path)}
          ><code>{summary}</code></Button>
        ) : (
          <code>{summary}</code>
        )}
        {onMove && onRemove && (
          <span style={{ display: "inline-flex", gap: "0.1rem" }}>
            {/* Outside a route Caddy orders handle blocks itself, so moving them would change nothing (#362). */}
            <Button variant="plain" size="sm" aria-label={`${t("tree.move_up")}: ${kindLabel} ${summary}`} isDisabled={locked || !inRoute || path[path.length - 1] === 0} onClick={() => onMove(path, -1)}>↑</Button>
            <Button variant="plain" size="sm" aria-label={`${t("tree.move_down")}: ${kindLabel} ${summary}`} isDisabled={locked || !inRoute || path[path.length - 1] === siblings - 1} onClick={() => onMove(path, 1)}>↓</Button>
            <Button variant="plain" size="sm" isDanger aria-label={`${t("tree.remove")}: ${kindLabel} ${summary}`} isDisabled={locked} onClick={() => onRemove(path)}>✕</Button>
          </span>
        )}
      </div>
      {handlers.length > 0 && (
        <ul style={{ ...listStyle, color: "var(--pf-t--global--text--color--subtle)" }} aria-label={t("tree.handlers")}>
          {handlers.map((h, i) => <li key={i}><code style={{ fontSize: "0.85rem" }}>{h}</code></li>)}
        </ul>
      )}
      {children.length > 0 && (
        <ul role="group" style={listStyle}>
          {children.map((c, i) => <NodeView key={i} node={c} scopes={own} path={[...path, i]} siblings={children.length} inRoute={node.kind === "route"} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} locked={locked} />)}
        </ul>
      )}
    </li>
  );
}

/** The route and handle blocks of a site, read-only (#349). */
export function SiteTreeView({ tree, selected, onSelect, onMove, onRemove, locked }: { tree: SiteTree } & Select) {
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
          {roots.map((n, i) => <NodeView key={i} node={n} scopes={scopes} path={[i]} siblings={roots.length} inRoute={false} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} locked={locked} />)}
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
  const matcherError = validateNodeEdit({ matcher: edit.matcher }, node.kind);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <FormGroup label={t("tree.matcher_label")} fieldId="tree-matcher">
        <TextInput
          id="tree-matcher"
          value={edit.matcher ?? node.matcher}
          onChange={(_e, v) => onChange({ ...edit, matcher: v })}
          placeholder={node.kind === "handle_path" ? "/app/*" : "@name"}
          validated={matcherError ? "error" : "default"}
          isDisabled={isDisabled}
        />
        <FormHelperText>
          <HelperText>
            <HelperTextItem variant={matcherError ? "error" : "default"}>
              {matcherError === "handle_path" ? t("tree.handle_path_invalid") : t("tree.matcher_help")}
            </HelperTextItem>
          </HelperText>
        </FormHelperText>
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
 * editable, and nodes added, removed and moved, when `onSave` is given (#350, #351). The edits
 * are applied to the text on Save; nodes the form does not know stay read-only (they can be
 * moved or deleted) and every line not edited stays as written.
 */
export function SiteTreeTab({ siteText, onSave }: { siteText: string; onSave?: (text: string, expected: string) => Promise<void> }) {
  const { t } = useTranslation();
  // The text the edits start from: the site's block as read, then as last saved. A save sends it
  // along, so a block changed elsewhere meanwhile is not overwritten (#362).
  const [base, setBase] = useState(siteText);
  const original = parseSiteTree(base);
  const [tree, setTree] = useState<SiteTree | undefined>(original);
  const [selected, setSelected] = useState<NodePath | undefined>();
  const [edit, setEdit] = useState<{ matcher?: string; handlers: Record<number, string> }>({ handlers: {} });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NodePath | undefined>();
  const [addKind, setAddKind] = useState<TreeKind>("handle");
  const [addMatcher, setAddMatcher] = useState("");

  if (!original || !tree) return <p>{t("tree.unreadable")}</p>;
  const node = selected ? nodeAt(tree, selected) : undefined;
  // An invalid edit can't be applied, so moving on would drop what was typed: everything else
  // waits until it is fixed or discarded (#362).
  const invalid = !!validateNodeEdit(edit, node?.kind);

  /** The tree with what is typed for the selected node applied to it. */
  function apply(): SiteTree {
    return selected && node && !invalid ? editNode(tree!, selected, edit) : tree!;
  }

  function choose(p: NodePath) {
    if (invalid) return;
    // Moving to another node keeps what was typed for this one.
    setTree(apply());
    setEdit({ handlers: {} });
    setSelected(p);
  }

  function move(p: NodePath, direction: -1 | 1) {
    if (invalid || !orderMatters(tree!, p)) return;
    const moved = moveNode(apply(), p, direction);
    if (!moved) return;
    setTree(moved.tree);
    setEdit({ handlers: {} });
    setSelected(moved.path);
    setPendingDelete(undefined);
  }

  function remove(p: NodePath) {
    if (invalid) return;
    const target = nodeAt(apply(), p);
    if (target && target.kind !== "opaque" && countDescendants(target) > 0) setPendingDelete(p);
    else doRemove(p);
  }

  function doRemove(p: NodePath) {
    setTree(removeNode(apply(), p));
    setEdit({ handlers: {} });
    setSelected(undefined);
    setPendingDelete(undefined);
  }

  const addTarget = node && node.kind !== "opaque" ? selected! : [];
  const addMatcherInvalid = !!validateNodeEdit({ matcher: addMatcher }, addKind);

  function add() {
    if (invalid) return;
    const added = addNode(apply(), addTarget, { kind: addKind, matcher: addMatcher });
    if (!added) return;
    setTree(added.tree);
    setEdit({ handlers: {} });
    setSelected(added.path);
    setAddMatcher("");
  }

  async function save() {
    const next = apply();
    setSaving(true);
    setError(null);
    try {
      const text = serializeSiteTree(next);
      await onSave?.(text, base);
      setBase(text);
      setTree(next);
      setEdit({ handlers: {} });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const changed = serializeSiteTree(apply()) !== base;
  const anyUnordered = hasUnorderedSiblings(tree.items, false);
  const doomed = pendingDelete ? nodeAt(tree, pendingDelete) : undefined;

  return (
    <>
      <p style={{ margin: 0, color: "var(--pf-t--global--text--color--subtle)" }}>{t(onSave ? "tree.edit_help" : "tree.read_only_help")}</p>
      <SiteTreeView
        tree={tree}
        selected={selected}
        onSelect={onSave ? choose : undefined}
        onMove={onSave ? move : undefined}
        onRemove={onSave ? remove : undefined}
        locked={invalid}
      />
      {onSave && anyUnordered && (
        <HelperText><HelperTextItem>{t("tree.move_hint")}</HelperTextItem></HelperText>
      )}
      {onSave && invalid && (
        <HelperText><HelperTextItem variant="warning">{t("tree.fix_first")}</HelperTextItem></HelperText>
      )}
      {doomed && pendingDelete && (
        <Alert
          variant="warning"
          isInline
          role="alertdialog"
          title={t("tree.remove_confirm", { count: countDescendants(doomed) })}
          actionClose={null}
        >
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="danger" size="sm" onClick={() => doRemove(pendingDelete)}>{t("tree.remove_yes")}</Button>
            <Button variant="link" size="sm" onClick={() => setPendingDelete(undefined)}>{t("tree.remove_no")}</Button>
          </div>
        </Alert>
      )}
      {onSave && node && node.kind !== "opaque" && (
        <NodeFields key={selected?.join(".")} node={node} edit={edit} onChange={setEdit} isDisabled={saving} />
      )}
      {onSave && (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <FormGroup label={t("tree.add_kind")} fieldId="tree-add-kind">
            <FormSelect id="tree-add-kind" value={addKind} onChange={(_e, v) => setAddKind(v as TreeKind)} isDisabled={saving} style={{ maxWidth: "11rem" }}>
              {TREE_KINDS.map(k => <FormSelectOption key={k} value={k} label={k} />)}
            </FormSelect>
          </FormGroup>
          <FormGroup label={t("tree.add_matcher")} fieldId="tree-add-matcher">
            <TextInput
              id="tree-add-matcher"
              value={addMatcher}
              onChange={(_e, v) => setAddMatcher(v)}
              placeholder={addKind === "handle_path" ? "/app/*" : "@name"}
              validated={addMatcher && addMatcherInvalid ? "error" : "default"}
              isDisabled={saving}
            />
          </FormGroup>
          <Button variant="secondary" isDisabled={addMatcherInvalid || invalid || saving} onClick={add}>
            {node && node.kind !== "opaque" ? t("tree.add_inside") : t("tree.add_top")}
          </Button>
        </div>
      )}
      {error && <Alert variant="danger" isInline title={error} />}
      {onSave && (
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button variant="primary" isDisabled={!changed || invalid || saving} isLoading={saving} onClick={() => void save()}>{t("tree.save")}</Button>
          <Button variant="link" isDisabled={!changed || saving} onClick={() => { setTree(parseSiteTree(base)); setEdit({ handlers: {} }); setSelected(undefined); setPendingDelete(undefined); setError(null); }}>{t("tree.discard")}</Button>
        </div>
      )}
    </>
  );
}
