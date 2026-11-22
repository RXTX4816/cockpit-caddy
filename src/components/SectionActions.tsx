import { useState } from "react";
import { Alert, Button } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useFlatSections } from "./sectionLayout";

type PendingAction = "clear" | "defaults";

interface Props {
  onClear?: () => void;
  onDefaults?: () => void;
  isDisabled?: boolean;
}

export function SectionActions({ onClear, onDefaults, isDisabled }: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingAction | null>(null);
  // Inside the tabbed proxy dialog (#260) each field has its own reset instead.
  const flat = useFlatSections();

  function confirm() {
    if (pending === "clear") onClear?.();
    else if (pending === "defaults") onDefaults?.();
    setPending(null);
  }

  if (flat) return null;

  if (pending) {
    return (
      <Alert
        variant="warning"
        isInline
        title={pending === "clear" ? t("common.confirm_clear") : t("common.confirm_defaults")}
        style={{ marginBottom: "var(--pf-v6-global--spacer--sm)" }}
        actionLinks={
          <>
            <Button variant="link" isInline onClick={confirm} style={{ marginRight: "0.75rem" }}>
              {t("common.confirm_apply")}
            </Button>
            <Button variant="link" isInline onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", marginBottom: "var(--pf-v6-global--spacer--sm)" }}>
      {onClear && (
        <Button variant="secondary" size="sm" onClick={() => setPending("clear")} isDisabled={isDisabled}>
          {t("common.clear")}
        </Button>
      )}
      {onDefaults && (
        <Button variant="secondary" size="sm" onClick={() => setPending("defaults")} isDisabled={isDisabled}>
          {t("common.defaults")}
        </Button>
      )}
    </div>
  );
}
