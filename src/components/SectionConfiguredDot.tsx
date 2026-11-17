import { useTranslation } from "react-i18next";

/** Small indicator shown next to a collapsed accordion section's title when it holds a
 *  non-default value (#146) — lets the user scan the group without expanding every row. */
export function SectionConfiguredDot() {
  const { t } = useTranslation();
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
