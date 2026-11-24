import { useMemo, useState } from "react";
import {
  Checkbox,
  Label,
  Tab,
  Tabs,
  TabTitleText,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { LogViewer } from "@rxtx4816/cockpit-plugin-base-react/components";
import { useLocalStorage } from "@rxtx4816/cockpit-plugin-base-react";
import { ACCESS_LOG_PREFIX, isAdminApiRequest, matchesLevel, matchesLogger, parseCaddyLogLine, type LevelFilter, type ParsedLogLine } from "./caddyLog";
import { LogTable } from "./LogTable";
import { useTranslation } from "react-i18next";
import { useLogs, CONTAINER_NOT_CONFIGURED } from "../hooks/useLogs";

interface Props {
  filterValue?: string;
  onFilterChange?: (v: string) => void;
}

type ViewMode = "table" | "raw";

const LEVEL_CHIP_COLORS: Record<LevelFilter, "grey" | "red" | "orange" | "blue"> = {
  all: "grey",
  error: "red",
  warn: "orange",
  info: "blue",
};

export function LogsViewer({ filterValue, onFilterChange }: Props) {
  const { t } = useTranslation();
  const { logs, loading, error, refresh, paused, pause, resume } = useLogs();
  const displayError = error === CONTAINER_NOT_CONFIGURED ? t("logs.container_not_configured") : error;

  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [activeLogger, setActiveLogger] = useState<string>("all");
  const [showAdminRequests, setShowAdminRequests] = useState(false);

  const [mode, setMode] = useLocalStorage<ViewMode>("cockpit-caddy:log-view", "table");
  const [tableSearch, setTableSearch] = useState(filterValue ?? "");
  const [isRegex, setIsRegex] = useState(false);
  const search = filterValue ?? tableSearch;
  const setSearch = (v: string) => { setTableSearch(v); onFilterChange?.(v); };

  // Each line is parsed once: the poll returns mostly the same lines, so keep the earlier parses
  // and drop the ones that scrolled out of the window.
  const [cache] = useState(() => new Map<string, ParsedLogLine>());
  const parsed = useMemo(() => {
    const lines = logs.split("\n").filter(Boolean);
    const out = lines.map(line => {
      let p = cache.get(line);
      if (!p) cache.set(line, (p = parseCaddyLogLine(line)));
      return p;
    });
    const current = new Set(lines);
    for (const key of cache.keys()) if (!current.has(key)) cache.delete(key);
    return out;
  }, [logs, cache]);

  const loggers = useMemo(() => {
    const seen = new Set<string>();
    for (const l of parsed) if (l.logger) seen.add(l.logger);
    return [...seen].sort();
  }, [parsed]);

  const caddyLoggers = useMemo(
    () => loggers.filter(l => !l.startsWith(ACCESS_LOG_PREFIX)),
    [loggers],
  );

  const accessLoggers = useMemo(
    () => loggers.filter(l => l.startsWith(ACCESS_LOG_PREFIX)),
    [loggers],
  );

  const filtered = useMemo(
    () => parsed.filter(l =>
      matchesLogger(l, activeLogger) && matchesLevel(l, levelFilter) && (showAdminRequests || !isAdminApiRequest(l))),
    [parsed, activeLogger, levelFilter, showAdminRequests],
  );
  const filteredLines = useMemo(() => filtered.map(l => l.raw), [filtered]);

  const showFilters = loggers.length > 0;

  const toolbarExtra = (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
      {showFilters && (
        <div style={{ display: "flex", gap: "0.3rem" }}>
          {(["all", "error", "warn", "info"] as LevelFilter[]).map(l => (
            <Label
              key={l}
              isCompact
              color={LEVEL_CHIP_COLORS[l]}
              variant={levelFilter === l ? "filled" : "outline"}
              onClick={() => setLevelFilter(l)}
              style={{ cursor: "pointer" }}
            >
              {t(`logs.level_${l}`)}
            </Label>
          ))}
        </div>
      )}
      <Checkbox
        id="log-show-admin-requests"
        label={t("logs.show_admin_requests")}
        isChecked={showAdminRequests}
        onChange={(_e, v) => setShowAdminRequests(v)}
      />
      <ToggleGroup isCompact aria-label={t("logs.view_label")}>
        <ToggleGroupItem text={t("logs.view_table")} buttonId="log-view-table" isSelected={mode === "table"} onChange={() => setMode("table")} />
        <ToggleGroupItem text={t("logs.view_raw")} buttonId="log-view-raw" isSelected={mode === "raw"} onChange={() => setMode("raw")} />
      </ToggleGroup>
    </div>
  );

  return (
    <>
      {showFilters && (
          <Tabs
            activeKey={activeLogger}
            onSelect={(_e, key) => setActiveLogger(String(key))}
            style={{ marginBottom: "0.25rem" }}
          >
            {/* PF6 Tabs expects TabElement children; build the list as an array and cast */}
            {([
              <Tab key="all" eventKey="all" title={<TabTitleText>{t("logs.tab_all")}</TabTitleText>} />,
              ...(caddyLoggers.length > 0
                ? [<Tab key="caddy" eventKey="caddy" title={<TabTitleText>{t("logs.tab_caddy")}</TabTitleText>} />]
                : []),
              ...accessLoggers.map(logger => (
                <Tab
                  key={logger}
                  eventKey={logger}
                  title={<TabTitleText>{logger.slice(ACCESS_LOG_PREFIX.length)}</TabTitleText>}
                />
              )),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any)}
          </Tabs>
        )}

      {mode === "table" ? (
        <LogTable
          lines={filtered}
          loading={loading}
          error={displayError}
          onRefresh={refresh}
          paused={paused}
          onPause={pause}
          onResume={resume}
          search={search}
          onSearchChange={setSearch}
          isRegex={isRegex}
          onRegexChange={setIsRegex}
          toolbarExtra={toolbarExtra}
        />
      ) : (
      <LogViewer
        lines={filteredLines}
        loading={loading}
        error={displayError}
        onRefresh={refresh}
        paused={paused}
        onPause={pause}
        onResume={resume}
        downloadFileName="caddy-logs"
        searchPlaceholder={t("logs.search_placeholder")}
        emptyMessage={t("logs.empty")}
        noMatchesMessage={t("logs.no_matches")}
        errorTitle={t("logs.load_failed")}
        refreshAriaLabel={t("common.refresh")}
        filterValue={filterValue}
        onFilterChange={onFilterChange}
        extraToolbarItems={toolbarExtra}
      />
      )}
    </>
  );
}
