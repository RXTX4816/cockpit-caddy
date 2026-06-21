import { StatusBadge as BaseStatusBadge, type StatusBadgeConfig } from "@rxtx4816/cockpit-plugin-base-react/components";
import { useTranslation } from "react-i18next";
import type { ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
}

export function StatusBadge({ status }: Props) {
  const { t } = useTranslation();

  const config: Record<ServiceStatus, StatusBadgeConfig> = {
    active: { color: "green", label: t("service.running") },
    inactive: { color: "grey", label: t("service.stopped") },
    failed: { color: "red", label: t("service.failed") },
    "not-installed": { color: "orange", label: t("service.not_installed") },
    unknown: { color: "grey", label: t("service.unknown") },
  };

  return <BaseStatusBadge status={status} config={config} />;
}
