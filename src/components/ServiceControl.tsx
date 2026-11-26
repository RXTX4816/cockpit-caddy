import { useState, type ReactNode } from "react";
import { Button, Dropdown, DropdownItem, DropdownList, Flex, FlexItem, Label, MenuToggle, Spinner, Tooltip } from "@patternfly/react-core";
import { EllipsisVIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";
import { ServiceStatusBadge, startService, stopService, restartService } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import { ConfirmDialog, useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { notifyConfigChanged, reloadCaddy, type ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
  loading: boolean;
  onRefresh: () => void;
  extraActions?: ReactNode;
  /** True when Caddy is only reachable via the Admin API (no local systemd unit) — e.g. running in a container. */
  unmanaged?: boolean;
}

type Action = "start" | "stop" | "restart" | "reload";
const UNIT = "caddy";

/**
 * The service row (#259): a status label, one visible action (Restart while running, Start when
 * stopped) and a kebab with Stop and Reload config. Every systemctl action asks first.
 *
 * Unmanaged mode (Caddy only reachable through the Admin API, e.g. in a container) has no
 * systemd actions; Reload config still works through the Admin API (see reloadCaddy).
 */
export function ServiceControl({ status, loading, onRefresh, extraActions, unmanaged = false }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = status === "active";
  const disabled = busy || loading || status === "not-installed";

  // A start, restart or reload loads the config from disk, so the site list refetches it (#284).
  const run: Record<Action, () => Promise<void>> = {
    start: () => startService(UNIT).then(notifyConfigChanged),
    stop: () => stopService(UNIT),
    // Through reloadCaddy, so a reload or restart that moves the admin endpoint is done safely (#330).
    restart: () => (unmanaged ? restartService(UNIT).then(notifyConfigChanged) : reloadCaddy({ restart: true }).then(() => undefined)),
    reload: () => reloadCaddy().then(() => undefined),
  };
  const success: Record<Action, string> = {
    start: t("toast.service_started"),
    stop: t("toast.service_stopped"),
    restart: t("toast.service_restarted"),
    reload: t("toast.service_reloaded"),
  };
  const confirm: Record<Action, [string, string]> = {
    start: [t("service.confirm_start_title"), t("service.confirm_start_body")],
    stop: [t("service.confirm_stop_title"), t("service.confirm_stop_body")],
    restart: [t("service.confirm_restart_title"), t("service.confirm_restart_body")],
    reload: [t("service.confirm_reload_title"), t("service.confirm_reload_body")],
  };

  async function runPending() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await run[pending]();
      toast.success(success[pending]);
      setPending(null);
      onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(pending === "reload" ? t("service.reload_failed") : t("service.action_failed"), msg);
    } finally {
      setBusy(false);
    }
  }

  const open = (a: Action) => { setError(null); setPending(a); };

  return (
    <>
      <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
        <FlexItem>
          {loading ? <Spinner size="sm" aria-label={t("app.loading")} /> : (
            <Flex alignItems={{ default: "alignItemsCenter" }} gap={{ default: "gapSm" }}>
              <FlexItem><ServiceStatusBadge status={status} /></FlexItem>
              {unmanaged && <FlexItem><Label isCompact color="blue">{t("service.external_badge")}</Label></FlexItem>}
            </Flex>
          )}
        </FlexItem>
        {!unmanaged && (
          <FlexItem>
            {running
              ? <Button variant="secondary" size="sm" isDisabled={disabled} onClick={() => open("restart")}>{t("service.restart")}</Button>
              : <Button variant="primary" size="sm" isDisabled={disabled} onClick={() => open("start")}>{t("service.start")}</Button>}
          </FlexItem>
        )}
        <FlexItem>
          <Dropdown
            isOpen={menuOpen}
            onOpenChange={setMenuOpen}
            onSelect={() => setMenuOpen(false)}
            toggle={ref => (
              <Tooltip content={t("service.more_actions")}>
                <MenuToggle
                  ref={ref}
                  variant="plain"
                  size="sm"
                  aria-label={t("service.more_actions")}
                  isExpanded={menuOpen}
                  isDisabled={busy || loading}
                  onClick={() => setMenuOpen(o => !o)}
                  icon={<EllipsisVIcon />}
                />
              </Tooltip>
            )}
          >
            <DropdownList>
              {!unmanaged && (
                <DropdownItem isDisabled={disabled || !running} onClick={() => open("stop")}>{t("service.stop")}</DropdownItem>
              )}
              <DropdownItem isDisabled={busy || loading || (!unmanaged && (status === "not-installed" || !running))} onClick={() => open("reload")}>
                {t("service.reload")}
              </DropdownItem>
            </DropdownList>
          </Dropdown>
        </FlexItem>
        {extraActions && <FlexItem align={{ default: "alignRight" }}>{extraActions}</FlexItem>}
      </Flex>
      <ConfirmDialog
        isOpen={pending !== null}
        title={pending ? confirm[pending][0] : ""}
        body={pending ? confirm[pending][1] : undefined}
        confirmLabel={t("service.confirm_action")}
        cancelLabel={t("common.cancel")}
        variant={pending === "stop" || pending === "restart" ? "danger" : "primary"}
        loading={busy}
        error={error}
        onConfirm={() => void runPending()}
        onClose={() => { if (!busy) { setPending(null); setError(null); } }}
      />
    </>
  );
}
