import type { ReactNode } from "react";
import { Button, Popover } from "@patternfly/react-core";
import { OutlinedQuestionCircleIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";

/**
 * A question-mark button that opens an explanation (#347): for static hints that used to be a
 * permanent info box above a form. `topic` is the short name of what it explains.
 */
export function HelpPopover({ topic, children }: { topic: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover headerContent={topic} bodyContent={children}>
      <Button variant="plain" size="sm" isInline aria-label={t("common.more_about", { topic })} icon={<OutlinedQuestionCircleIcon />} />
    </Popover>
  );
}
