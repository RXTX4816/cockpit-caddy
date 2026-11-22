import { useTranslation } from "react-i18next";
import { useFlatSections } from "./sectionLayout";

/** Small indicator shown next to a collapsed accordion section's title when it holds a
 *  non-default value (#146) — lets the user scan the group without expanding every row. */
export function SectionConfiguredDot() {
  const { t } = useTranslation();
  const flat = useFlatSections();
  // A tab carries the dot in the tabbed proxy dialog (#260); the section headings don't.
  if (flat) return null;
  return (
    <span
      aria-label={t("common.configured")}
      title={t("common.configured")}
      style={{
        display: "inline-block",
        width: "0.5rem",
        height: "0.5rem",
        borderRadius: "50%",
        background: "var(--pf-t--global--icon--color--status--info--default, #2b9af3)",
        marginLeft: "0.5rem",
        verticalAlign: "middle",
      }}
    />
  );
}
