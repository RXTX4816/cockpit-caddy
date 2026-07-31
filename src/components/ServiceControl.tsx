import { useState, type ReactNode } from "react";
import { Button, Flex, FlexItem, Label, Spinner } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { ServiceControl as BaseServiceControl, ServiceStatusBadge } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { reloadCaddy, type ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
  loading: boolean;
  onRefresh: () => void;
  extraActions?: ReactNode;
  /** True when Caddy is only reachable via the Admin API (no local systemd unit) — e.g. running in a container. */
  unmanaged?: boolean;
}

/**
 * The base ServiceControl's own Reload button always disables itself when
 * there's no local systemd unit (`status === "not-installed"`), with no way
 * to override that or its systemctl-only action from the outside. In
 * unmanaged mode Reload *can* work (via the Admin API — see reloadCaddy), so
 * this replaces the whole action row with its own version instead of
 * duplicating a second Reload button next to the base component's disabled one.
 */
export function ServiceControl({ status, loading, onRefresh, extraActions, unmanaged = false }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [reloading, setReloading] = useState(false);

  async function handleReload() {
    setReloading(true);
    try {
      await reloadCaddy();
      toast.success(t("toast.service_reloaded"));
      onRefresh();
    } catch (e) {
      toast.error(t("service.reload_failed"), e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  }

  if (unmanaged) {
    return (
      <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
        <FlexItem>
          {loading ? <Spinner size="sm" /> : (
            <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
              <FlexItem><ServiceStatusBadge status={status} /></FlexItem>
              <FlexItem><Label isCompact color="blue">{t("service.external_badge")}</Label></FlexItem>
            </Flex>
          )}
        </FlexItem>
        <FlexItem><Button variant="primary" size="sm" isDisabled>{t("service.start")}</Button></FlexItem>
        <FlexItem><Button variant="secondary" size="sm" isDisabled>{t("service.stop")}</Button></FlexItem>
        <FlexItem><Button variant="secondary" size="sm" isDisabled>{t("service.restart")}</Button></FlexItem>
        <FlexItem>
          <Button
            variant="plain"
            size="sm"
            isLoading={reloading}
            isDisabled={reloading || loading}
            onClick={() => void handleReload()}
          >
            {t("service.reload")}
          </Button>
        </FlexItem>
        {extraActions && <FlexItem align={{ default: "alignRight" }}>{extraActions}</FlexItem>}
      </Flex>
    );
  }

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
