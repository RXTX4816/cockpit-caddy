import { createContext, useContext, useState } from "react";
import {
  Alert,
  Dropdown,
  DropdownItem,
  DropdownList,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  LabelGroup,
  MenuToggle,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { SnippetDef } from "../api";

/** The known snippets (#288), provided by the proxy list so every site dialog can offer them. */
export const SnippetsContext = createContext<SnippetDef[]>([]);

interface Props {
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
  /** Snippets that supplied settings the dialog doesn't show (ProxyEntry.snippetSettings). */
  snippetSettings?: string[];
  isDisabled?: boolean;
}

/** `import <snippet>` lines at the top of the site block, picked as chips. */
export function SnippetImportsField({ value, onChange, snippetSettings, isDisabled }: Props) {
  const { t } = useTranslation();
  const snippets = useContext(SnippetsContext);
  const [open, setOpen] = useState(false);
  const selected = value ?? [];
  const available = snippets.map(s => s.name).filter(n => !selected.includes(n));

  const set = (next: string[]) => onChange(next.length ? next : undefined);

  if (!snippets.length && !selected.length) return null;

  return (
    <FormGroup label={t("snippets.imports_label")} fieldId="site-imports" role="group">
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        {selected.length > 0 && (
          <LabelGroup aria-label={t("snippets.imports_label")} numLabels={10}>
            {selected.map(name => (
              <Label
                key={name}
                color={snippets.some(s => s.name === name) ? "blue" : "red"}
                onClose={isDisabled ? undefined : () => set(selected.filter(n => n !== name))}
                closeBtnAriaLabel={t("snippets.remove_import", { name })}
              >
                {name}
              </Label>
            ))}
          </LabelGroup>
        )}
        <Dropdown
          isOpen={open}
          onOpenChange={setOpen}
          onSelect={(_e, v) => { set([...selected, String(v)]); setOpen(false); }}
          toggle={ref => (
            <MenuToggle ref={ref} id="site-imports" size="sm" onClick={() => setOpen(o => !o)} isExpanded={open} isDisabled={isDisabled || !available.length}>
              {t("snippets.add_import")}
            </MenuToggle>
          )}
        >
          <DropdownList>
            {available.map(name => <DropdownItem key={name} value={name}>{name}</DropdownItem>)}
          </DropdownList>
        </Dropdown>
      </div>
      <FormHelperText>
        <HelperText>
          <HelperTextItem>{t("snippets.imports_help")}</HelperTextItem>
        </HelperText>
      </FormHelperText>
      {snippetSettings?.length ? (
        <Alert variant="info" isInline isPlain title={t("snippets.settings_from_snippet", { names: snippetSettings.join(", ") })} style={{ marginTop: "0.5rem" }} />
      ) : null}
    </FormGroup>
  );
}
