import { Alert, type AlertProps } from "@patternfly/react-core";

/**
 * The plugin's message box (#347): a PatternFly Alert with one spacing, so screens stop
 * hand-rolling margins. Inline by default; a page-level banner passes `isInline={false}`. Use the
 * variant for the kind of message (danger = failed, warning = needs action, info = FYI), a short
 * title, and the longer explanation or exact error as the children. Transient success belongs in
 * a toast, not here.
 */
export function Notice({ style, isInline = true, ...props }: AlertProps) {
  return <Alert isInline={isInline} {...props} style={{ marginBlock: "var(--pf-t--global--spacer--sm, 0.5rem)", ...style }} />;
}
