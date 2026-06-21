import { LogViewer } from "@rxtx4816/cockpit-plugin-base-react/components";
import { useTranslation } from "react-i18next";
import { useLogs } from "../hooks/useLogs";

export function LogsViewer() {
  const { t } = useTranslation();
  const { logs, loading, error, refresh, paused, pause, resume } = useLogs();

  const lines = logs.split("\n").filter(Boolean);

  return (
    <LogViewer
      lines={lines}
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
    />
  );
}
