import { Tooltip } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ProbeStatus } from "../api/probe";

const STATUS_COLOR: Record<ProbeStatus, string> = {
  pending: "var(--pf-t--global--color--status--info--default)",
  up:      "var(--pf-t--global--color--status--success--default)",
  down:    "var(--pf-t--global--color--status--danger--default)",
  error:   "var(--pf-t--global--color--status--warning--default)",
};

interface Props {
  status: ProbeStatus;
  address: string;
}

export function UpstreamStatusDot({ status, address }: Props) {
  const { t } = useTranslation();
  return (
    <Tooltip content={`${address} — ${t(`probe.status_${status}`)}`} position="top">
      <span
        style={{
          display: "inline-block",
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: STATUS_COLOR[status],
          flexShrink: 0,
          cursor: "help",
          verticalAlign: "middle",
        }}
      />
    </Tooltip>
  );
}
