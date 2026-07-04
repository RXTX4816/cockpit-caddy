import { type ReactNode } from "react";
import { ServiceControl as BaseServiceControl, ServiceStatusBadge } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import { useTranslation } from "react-i18next";
import type { ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
  loading: boolean;
  onRefresh: () => void;
  extraActions?: ReactNode;
}

export function ServiceControl({ status, loading, onRefresh, extraActions }: Props) {
  const { t } = useTranslation();

  return (
    <BaseServiceControl
      unit="caddy"
      status={status}
      loading={loading}
      onRefresh={onRefresh}
      statusBadge={<ServiceStatusBadge status={status} />}
      extraActions={extraActions}
      labels={{
        start: t("service.start"),
        stop: t("service.stop"),
        restart: t("service.restart"),
        reload: t("service.reload"),
        cancel: t("common.cancel"),
        confirmAction: t("service.confirm_action"),
        confirmStartTitle: t("service.confirm_start_title"),
        confirmStartBody: t("service.confirm_start_body"),
        confirmStopTitle: t("service.confirm_stop_title"),
        confirmStopBody: t("service.confirm_stop_body"),
        confirmRestartTitle: t("service.confirm_restart_title"),
        confirmRestartBody: t("service.confirm_restart_body"),
        confirmReloadTitle: t("service.confirm_reload_title"),
        confirmReloadBody: t("service.confirm_reload_body"),
        successStart: t("toast.service_started"),
        successStop: t("toast.service_stopped"),
        successRestart: t("toast.service_restarted"),
        successReload: t("toast.service_reloaded"),
      }}
    />
  );
}
