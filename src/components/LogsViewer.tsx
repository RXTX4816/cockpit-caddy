import { useMemo, useState } from "react";
import {
  Label,
  Tab,
  Tabs,
  TabTitleText,
} from "@patternfly/react-core";
import { LogViewer } from "@rxtx4816/cockpit-plugin-base-react/components";
import { useTranslation } from "react-i18next";
import { useLogs } from "../hooks/useLogs";

interface Props {
  filterValue?: string;
  onFilterChange?: (v: string) => void;
}

type LevelFilter = "all" | "error" | "warn" | "info";

const LEVEL_COLORS: Record<LevelFilter, "grey" | "red" | "orange" | "blue"> = {
  all: "grey",
  error: "red",
  warn: "orange",
  info: "blue",
};

/** Caddy's stable namespace for HTTP access logs. */
const ACCESS_LOG_PREFIX = "http.log.access.";

/** Extract a field from a JSON log line that may have a journalctl timestamp prefix. */
function parseJsonField(line: string, field: string): string | undefined {
  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) return undefined;
  try {
    const obj = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
    const v = obj[field];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function LogsViewer({ filterValue, onFilterChange }: Props) {
  const { t } = useTranslation();
  const { logs, loading, error, refresh, paused, pause, resume } = useLogs();

  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [activeLogger, setActiveLogger] = useState<string>("all");

  const lines = useMemo(() => logs.split("\n").filter(Boolean), [logs]);

  const loggers = useMemo(() => {
    const seen = new Set<string>();
    for (const line of lines) {
      const logger = parseJsonField(line, "logger");
      if (logger) seen.add(logger);
    }
    return [...seen].sort();
  }, [lines]);

  const caddyLoggers = useMemo(
    () => loggers.filter(l => !l.startsWith(ACCESS_LOG_PREFIX)),
    [loggers],
  );

  const accessLoggers = useMemo(
    () => loggers.filter(l => l.startsWith(ACCESS_LOG_PREFIX)),
    [loggers],
  );

  const filteredLines = useMemo(() => {
    return lines.filter(line => {
      const logger = parseJsonField(line, "logger");

      if (activeLogger !== "all") {
        if (activeLogger === "caddy") {
          // "Caddy" tab: show caddy internal logs + lines without a logger field
          if (logger && logger.startsWith(ACCESS_LOG_PREFIX)) return false;
        } else {
          // Service tab: only this specific logger
          if (logger !== activeLogger) return false;
        }
      }

      if (levelFilter !== "all") {
        const level = parseJsonField(line, "level")?.toLowerCase();
        if (!level) return levelFilter === "info";
        if (levelFilter === "error") return level === "error";
        if (levelFilter === "warn") return level === "error" || level === "warn";
      }

      return true;
    });
  }, [lines, activeLogger, levelFilter]);

  const showFilters = loggers.length > 0;

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

      <LogViewer
        lines={filteredLines}
        loading={loading}
        error={error}
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
        extraToolbarItems={showFilters ? (
          <div style={{ display: "flex", gap: "0.3rem" }}>
            {(["all", "error", "warn", "info"] as LevelFilter[]).map(l => (
              <Label
                key={l}
                isCompact
                color={LEVEL_COLORS[l]}
                variant={levelFilter === l ? "filled" : "outline"}
                onClick={() => setLevelFilter(l)}
                style={{ cursor: "pointer" }}
              >
                {t(`logs.level_${l}`)}
              </Label>
            ))}
          </div>
        ) : undefined}
      />
    </>
  );
}
