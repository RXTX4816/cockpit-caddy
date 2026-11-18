import { useState } from "react";
import { Button, Dropdown, DropdownItem, DropdownList, MenuToggle, Tooltip } from "@patternfly/react-core";
import { EllipsisVIcon, PencilAltIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";

interface Props {
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/**
 * A site row's actions (#259): Edit as a visible icon button, Duplicate and Delete in a kebab,
 * so the destructive action never sits next to Edit. Delete still asks for confirmation upstream.
 */
export function RowActions({ onEdit, onDuplicate, onDelete }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
      <Tooltip content={t("common.edit")}>
        <Button variant="plain" size="sm" aria-label={t("common.edit")} icon={<PencilAltIcon />} onClick={onEdit} />
      </Tooltip>
      <Dropdown
        isOpen={open}
        onOpenChange={setOpen}
        onSelect={() => setOpen(false)}
        popperProps={{ position: "right" }}
        toggle={ref => (
          <Tooltip content={t("proxies.more_actions")}>
            <MenuToggle ref={ref} variant="plain" size="sm" aria-label={t("proxies.more_actions")} isExpanded={open} onClick={() => setOpen(o => !o)} icon={<EllipsisVIcon />} />
          </Tooltip>
        )}
      >
        <DropdownList>
          <DropdownItem onClick={onDuplicate}>{t("common.duplicate")}</DropdownItem>
          <DropdownItem onClick={onDelete} isDanger>{t("common.delete")}</DropdownItem>
        </DropdownList>
      </Dropdown>
    </span>
  );
}
