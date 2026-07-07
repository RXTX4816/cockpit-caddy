/**
 * Coordinates a group of optional-settings sections (TlsSection, AccessLogSection, etc.) so
 * only one is expanded at a time, accordion-style (#146) — each section keeps its own
 * ExpandableSection rendering, just with its expand state lifted to a single shared key
 * instead of managed internally. Not a hook: safe to call inline in JSX props.
 */
export function sectionAccordionProps(
  key: string,
  expandedKey: string | null,
  setExpandedKey: (k: string | null) => void,
): { isExpanded: boolean; onToggleExpanded: (v: boolean) => void } {
  return {
    isExpanded: expandedKey === key,
    onToggleExpanded: (v: boolean) => setExpandedKey(v ? key : null),
  };
}
