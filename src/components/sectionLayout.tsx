import { createContext, useContext, useId, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Button, ExpandableSection, TextInput, Title, Tooltip, type TextInputProps } from "@patternfly/react-core";
import { UndoIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";

/**
 * True inside the tabbed proxy dialog (#260): sections render as plain headed field groups
 * instead of accordions, without the per-section Clear / Defaults buttons, and fields get a
 * per-field "Reset to Caddy default" button instead. Every other dialog keeps the accordions.
 */
export const FlatSectionsContext = createContext(false);

export function useFlatSections(): boolean {
  return useContext(FlatSectionsContext);
}

interface ShellProps {
  /** The section's name as a heading inside a tab (#291), e.g. "HTTP Basic Auth". */
  heading: string;
  toggleContent?: ReactNode;
  toggleText?: string;
  isIndented?: boolean;
  isExpanded: boolean;
  onToggle: (event: unknown, expanded: boolean) => void;
  style?: CSSProperties;
  children: ReactNode;
}

/** An ExpandableSection, or a headed field group inside the tabbed proxy dialog. */
export function SectionShell({ heading, toggleContent, toggleText, isIndented, isExpanded, onToggle, style, children }: ShellProps) {
  const flat = useFlatSections();
  const id = useId();
  if (!flat) {
    return (
      <ExpandableSection toggleContent={toggleContent} toggleText={toggleText} isIndented={isIndented} isExpanded={isExpanded} onToggle={onToggle} style={style}>
        {children}
      </ExpandableSection>
    );
  }
  return (
    <section aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Title headingLevel="h4" size="md" id={id}>{heading}</Title>
      <div>{children}</div>
    </section>
  );
}

type ResettableProps = Omit<TextInputProps, "ref"> & { value: string };

/**
 * A TextInput whose empty value means Caddy's default. Inside the tabbed proxy dialog (#260) a
 * non-empty value gets a "Reset to Caddy default" button that empties it again.
 */
export function ResettableTextInput(props: ResettableProps) {
  const { t } = useTranslation();
  const flat = useFlatSections();
  const input = <TextInput {...props} />;
  if (!flat) return input;
  const label = t("common.reset_default");
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "0.25rem", ...(props.style?.flex ? { flex: props.style.flex } : {}) }}>
      <span style={{ flex: 1, minWidth: 0 }}>{input}</span>
      {props.value !== "" && !props.isDisabled ? (
        <Tooltip content={label}>
          <Button
            variant="plain"
            size="sm"
            aria-label={props["aria-label"] ? `${label}: ${props["aria-label"]}` : label}
            aria-controls={props.id}
            icon={<UndoIcon />}
            onClick={e => {
              props.onChange?.(e as unknown as FormEvent<HTMLInputElement>, "");
              // The button goes away once the field is empty; keep keyboard focus in the field.
              if (props.id) document.getElementById(props.id)?.focus();
            }}
          />
        </Tooltip>
      ) : (
        <span style={{ width: "2.25rem", flexShrink: 0 }} />
      )}
    </span>
  );
}
