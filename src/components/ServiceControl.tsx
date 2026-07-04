import { type ReactNode } from "react";
import { ServiceControl as BaseServiceControl, ServiceStatusBadge } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import type { ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
  loading: boolean;
  onRefresh: () => void;
  extraActions?: ReactNode;
}

export function ServiceControl({ status, loading, onRefresh, extraActions }: Props) {
  return (
    <BaseServiceControl
      unit="caddy"
      status={status}
      loading={loading}
      onRefresh={onRefresh}
      statusBadge={<ServiceStatusBadge status={status} />}
      extraActions={extraActions}
    />
  );
}
