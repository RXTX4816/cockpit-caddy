import { useState } from "react";
import { Button, Flex, FlexItem, Spinner } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "./StatusBadge";
import { startService, stopService, restartService, reloadService } from "../api";
import type { ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
  loading: boolean;
  onRefresh: () => void;
}

export function ServiceControl({ status, loading, onRefresh }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  const isRunning = status === "active";
  const notInstalled = status === "not-installed";

  return (
    <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
      <FlexItem>
        {loading ? <Spinner size="sm" /> : <StatusBadge status={status} />}
      </FlexItem>
      <FlexItem>
        <Button
          variant="primary"
          size="sm"
          isDisabled={busy || notInstalled || isRunning}
          onClick={() => run(startService)}
        >
          {t("service.start")}
        </Button>
      </FlexItem>
      <FlexItem>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={busy || notInstalled || !isRunning}
          onClick={() => run(stopService)}
        >
          {t("service.stop")}
        </Button>
      </FlexItem>
      <FlexItem>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={busy || notInstalled || !isRunning}
          onClick={() => run(restartService)}
        >
          {t("service.restart")}
        </Button>
      </FlexItem>
      <FlexItem>
        <Button
          variant="plain"
          size="sm"
          isDisabled={busy || notInstalled || !isRunning}
          onClick={() => run(reloadService)}
        >
          {t("service.reload")}
        </Button>
      </FlexItem>
    </Flex>
  );
}
