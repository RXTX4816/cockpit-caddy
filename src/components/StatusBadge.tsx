import { Label } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ServiceStatus } from "../api";

interface Props {
  status: ServiceStatus;
}

export function StatusBadge({ status }: Props) {
  const { t } = useTranslation();

  switch (status) {
    case "active":
      return <Label color="green">{t("service.running")}</Label>;
    case "inactive":
      return <Label color="grey">{t("service.stopped")}</Label>;
    case "failed":
      return <Label color="red">{t("service.failed")}</Label>;
    case "not-installed":
      return <Label color="orange">{t("service.not_installed")}</Label>;
    default:
      return <Label color="grey">{t("service.unknown")}</Label>;
  }
}
