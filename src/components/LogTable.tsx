import { saveTextToDownloads } from "@rxtx4816/cockpit-plugin-base-react/lib/saveText";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Alert,
  AlertActionCloseButton,
  Button,
  Label,
  SearchInput,
  Spinner,
  Stack,
  StackItem,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { colorizeJson } from "@rxtx4816/cockpit-plugin-base-react/lib/logParser";
import "@rxtx4816/cockpit-plugin-base-react/log-tokens.css";
import { matchesSearch, type ParsedLogLine } from "./caddyLog";

interface Props {
  /** Lines after the level filter and logger tab; the search is applied here. */
  lines: ParsedLogLine[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  isRegex: boolean;
  onRegexChange: (v: boolean) => void;
  /** Level chips and the Table / Raw switch. */
  toolbarExtra?: ReactNode;
}

export const LEVEL_COLORS: Record<string, "red" | "orange" | "blue" | "grey"> = {
  error: "red", fatal: "red", panic: "red", dpanic: "red", warn: "orange", info: "blue", debug: "grey",
};

const CELL: CSSProperties = {
  padding: "0.15rem 0.5rem",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  verticalAlign: "middle",
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fullTimeOf = (d: Date) => `${d.toLocaleDateString()} ${timeOf(d)}.${pad(d.getMilliseconds(), 3)}`;

function statusColor(status: number): string | undefined {
  if (status >= 500) return "var(--pf-t--global--text--color--status--danger--default, #c9190b)";
  if (status >= 400) return "var(--pf-t--global--text--color--status--warning--default, #c58c00)";
  return undefined;
}

/** Saves text through the File System Access API, else to ~/Downloads via cockpit (the helper the base LogViewer uses). */
async function saveText(fileName: string, text: string, typeLabel: string): Promise<string | null> {
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await (window as Window & {
        showSaveFilePicker(o: object): Promise<{ createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }>;
      }).showSaveFilePicker({ suggestedName: `${fileName}.txt`, types: [{ description: typeLabel, accept: { "text/plain": [".txt"] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return null;
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return null;
      // SecurityError inside Cockpit's iframe: fall through to cockpit.file
    }
  }
  return saveTextToDownloads(text, fileName);
}

/** Caddy's log lines as a table (#257): one row per line, the full JSON when a row is opened. */
export function LogTable({ lines, loading, error, onRefresh, paused, onPause, onResume, search, onSearchChange, isRegex, onRegexChange, toolbarExtra }: Props) {
  const { t } = useTranslation();
  // The base package's LogViewer labels, so both views read the same.
  const baseLabel = (key: string) => t(key);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const shown = lines.filter(l => matchesSearch(l, search, isRegex));
  // Keyed by content, not position, so an opened row stays open when the poll shifts the window.
  const seen = new Map<string, number>();
  const keys = shown.map(l => {
    const n = (seen.get(l.raw) ?? 0) + 1;
    seen.set(l.raw, n);
    return `${n}:${l.raw}`;
  });

  useEffect(() => {
    if (!paused && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, paused]);

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  async function download() {
    try {
      setSavedTo(await saveText("caddy-logs", shown.map(l => l.raw).join("\n"), baseLabel("logViewer.textFiles")));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  const count = shown.length !== lines.length ? `${shown.length} / ${lines.length}` : String(lines.length);
  const header = (key: string, width: string) => (
    <th scope="col" style={{ ...CELL, width, textAlign: "start", fontWeight: 600 }}>{t(key)}</th>
  );

  return (
    <Stack hasGutter>
      {error && (
        <StackItem>
          <Alert variant="danger" title={t("logs.load_failed")} actionLinks={<Button variant="link" onClick={onRefresh}>{t("common.retry")}</Button>}>
            {error}
          </Alert>
        </StackItem>
      )}
      {savedTo && (
        <StackItem>
          <Alert variant="info" isInline title={t("logs.saved_to", { path: savedTo })} actionClose={<AlertActionCloseButton onClose={() => setSavedTo(null)} />} />
        </StackItem>
      )}
      {saveError && (
        <StackItem>
          <Alert variant="danger" isInline title={saveError} actionClose={<AlertActionCloseButton onClose={() => setSaveError(null)} />} />
        </StackItem>
      )}
      <StackItem>
        <Toolbar style={{ paddingInline: 0 }}>
          <ToolbarContent>
            <ToolbarGroup variant="filter-group">
              <ToolbarItem>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <SearchInput
                    placeholder={t("logs.search_placeholder")}
                    value={search}
                    onChange={(_e, v) => onSearchChange(v)}
                    onClear={() => onSearchChange("")}
                    style={{ width: 220 }}
                  />
                  <Button
                    variant={isRegex ? "primary" : "secondary"}
                    size="sm"
                    aria-pressed={isRegex}
                    aria-label={baseLabel("logViewer.regexToggle")}
                    title={baseLabel("logViewer.regexToggle")}
                    onClick={() => onRegexChange(!isRegex)}
                    style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}
                  >
                    .*
                  </Button>
                </div>
              </ToolbarItem>
              <ToolbarItem style={{ alignSelf: "center" }}>
                <span style={{ fontSize: "0.75rem", color: "var(--pf-t--global--text--color--subtle)" }}>
                  {count} {baseLabel("logViewer.linesSuffix")}
                </span>
              </ToolbarItem>
            </ToolbarGroup>
            {toolbarExtra && <ToolbarItem style={{ alignSelf: "center" }}>{toolbarExtra}</ToolbarItem>}
            <ToolbarGroup variant="action-group-plain" align={{ default: "alignEnd" }}>
              <ToolbarItem>
                {paused
                  ? <Button variant="primary" size="sm" onClick={onResume}>▶ {baseLabel("logViewer.resume")}</Button>
                  : <Button variant="secondary" size="sm" onClick={onPause}>⏸ {baseLabel("logViewer.pause")}</Button>}
              </ToolbarItem>
              {shown.length > 0 && (
                <ToolbarItem>
                  <Button variant="plain" size="sm" onClick={() => void download()} aria-label={baseLabel("logViewer.download")} title={baseLabel("logViewer.download")}>⬇</Button>
                </ToolbarItem>
              )}
              <ToolbarItem>
                <Button variant="plain" size="sm" onClick={onRefresh} aria-label={t("common.refresh")} title={t("common.refresh")}>↺</Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </StackItem>
      <StackItem isFilled>
        {loading ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <p style={{ color: "var(--pf-t--global--text--color--subtle)" }}>{lines.length === 0 ? t("logs.empty") : t("logs.no_matches")}</p>
        ) : (
          <div ref={scrollRef} style={{ overflow: "auto", maxHeight: "60vh" }}>
            <table aria-label={t("logs.table_label")} style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontSize: "0.82rem" }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--pf-t--global--background--color--primary--default)" }}>
                <tr>
                  {header("logs.col_time", "6rem")}
                  {header("logs.col_level", "5rem")}
                  {header("logs.col_logger", "11rem")}
                  {header("logs.col_host", "10rem")}
                  {header("logs.col_request", "14rem")}
                  {header("logs.col_status", "4rem")}
                  {header("logs.col_message", "auto")}
                </tr>
              </thead>
              <tbody>
                {shown.map((l, i) => {
                  const key = keys[i];
                  const open = expanded.has(key);
                  return (
                    <Fragment key={key}>
                      <tr
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => toggle(key)}
                        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(key); } }}
                        style={{ cursor: "pointer", borderTop: "1px solid var(--pf-t--global--border--color--default)" }}
                      >
                        <td style={CELL} title={l.ts ? fullTimeOf(l.ts) : undefined}>{l.ts ? timeOf(l.ts) : ""}</td>
                        <td style={CELL}>{l.level && <Label isCompact color={LEVEL_COLORS[l.level] ?? "grey"}>{l.level}</Label>}</td>
                        <td style={CELL} title={l.logger}>{l.logger}</td>
                        <td style={CELL} title={l.host}>{l.host}</td>
                        <td style={{ ...CELL, fontFamily: "var(--pf-t--global--font--family--mono)" }} title={l.uri}>{l.method && `${l.method} `}{l.uri}</td>
                        <td style={{ ...CELL, color: l.status ? statusColor(l.status) : undefined, fontWeight: l.status && l.status >= 400 ? 600 : undefined }}>{l.status}</td>
                        <td style={CELL}>{l.msg}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} style={{ padding: "0.4rem 0.75rem", background: "var(--log-viewer-bg)", color: "var(--log-viewer-text)" }}>
                            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.78rem" }}>
                              {l.json ? colorizeJson(JSON.stringify(l.json, null, 2)) : l.raw}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </StackItem>
    </Stack>
  );
}
