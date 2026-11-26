import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageSection, Label } from "@patternfly/react-core";
import { ThirdPartyNoticesModal, type NoticesData } from "@rxtx4816/cockpit-plugin-base-react/components";
import pkg from "../../package.json";
// Generated at build time from the esbuild metafile — see scripts/build.mjs. Cockpit
// serves main.js to the browser, so the bundled packages' licenses have to be reachable
// from the UI, not only from THIRD-PARTY-NOTICES.txt on the server's disk.
import notices from "../generated/third-party-notices.json";

const SOURCE_URL = pkg.homepage as string;
const LINK_COLOR = "var(--pf-t--global--color--brand--default, #06c)";

interface Props {
  /** Running Caddy version, shown next to the plugin version once known. */
  caddyVersion?: string | null;
}

// Same markup and styles as the base's PluginFooter, which only renders <a> links; the
// licenses control opens a modal, so it has to be a button in the links row.
export function AppFooter({ caddyVersion }: Props) {
  const { t } = useTranslation();
  const [noticesOpen, setNoticesOpen] = useState(false);

  const links = [
    { label: t("footer.help"), href: SOURCE_URL + "/wiki" },
    { label: t("footer.feedback"), href: SOURCE_URL + "/issues/new/choose" },
    { label: t("footer.source"), href: SOURCE_URL },
  ];

  return (
    <PageSection
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 1,
        borderTop: "1px solid var(--pf-t--global--border--color--default)",
        padding: "0.5rem 1.5rem",
        fontSize: 13,
        textAlign: "center",
        backgroundColor: "var(--pf-t--global--background--color--primary--default)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", alignItems: "center" }}>
          <Label isCompact color="grey">v{pkg.version}</Label>
          {caddyVersion && (
            <Label isCompact color="blue">{t("footer.caddy_version", { version: caddyVersion })}</Label>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 16, justifyContent: "center" }}>
          {links.map(({ label, href }) => (
            <a key={href} href={href} target="_blank" rel="noopener noreferrer" style={{ color: LINK_COLOR, textDecoration: "none" }}>
              {label}
            </a>
          ))}
          <button
            type="button"
            onClick={() => setNoticesOpen(true)}
            style={{ color: LINK_COLOR, background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}
          >
            {t("footer.licenses")}
          </button>
        </div>
      </div>
      <ThirdPartyNoticesModal
        isOpen={noticesOpen}
        onClose={() => setNoticesOpen(false)}
        notices={notices as NoticesData}
        productName="cockpit-caddy"
        licenseName={pkg.license}
        sourceUrl={SOURCE_URL}
      />
    </PageSection>
  );
}
