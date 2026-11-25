import { useEffect, useState } from "react";
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  HelperText,
  HelperTextItem,
  Label,
  SearchInput,
  Spinner,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { listCaddyModules, moduleCapabilities, type CaddyModules } from "../api/caddyModules";

type State = { status: "loading" } | { status: "unknown" } | { status: "ready"; modules: CaddyModules };

/** The modules of the installed Caddy and which optional features they give (#343). */
export function CaddyModulesPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "loading" });
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listCaddyModules().then(modules => {
      if (!cancelled) setState(modules ? { status: "ready", modules } : { status: "unknown" });
    });
    return () => { cancelled = true; };
  }, []);

  if (state.status === "loading") return <Spinner size="md" aria-label={t("modules.loading")} />;
  if (state.status === "unknown") {
    return <HelperText><HelperTextItem variant="warning">{t("modules.unknown")}</HelperTextItem></HelperText>;
  }

  const { modules } = state;
  const shown = filter.trim() ? modules.all.filter(id => id.includes(filter.trim())) : modules.all;

  return (
    <>
      <HelperText style={{ marginBottom: "0.5rem" }}>
        <HelperTextItem>{t("modules.help")}</HelperTextItem>
        {modules.source === "admin-api" && <HelperTextItem>{t("modules.probed")}</HelperTextItem>}
      </HelperText>
      <DescriptionList isHorizontal isCompact>
        {moduleCapabilities(modules).map(c => (
          <DescriptionListGroup key={c.key}>
            <DescriptionListTerm>{t(`modules.cap_${c.key}`)}</DescriptionListTerm>
            <DescriptionListDescription>
              <Label isCompact color={c.available ? "green" : "grey"}>
                {c.available ? t("modules.installed") : c.available === false ? t("modules.missing") : t("modules.not_known")}
              </Label>
              {c.key === "dns" && c.available && <> {t("modules.dns_providers", { count: modules.dnsProviders.length })}</>}
              {!c.available && <> <a href={c.docs} target="_blank" rel="noopener noreferrer">{t("modules.how_to_get")}</a></>}
            </DescriptionListDescription>
          </DescriptionListGroup>
        ))}
      </DescriptionList>
      <ExpandableSection toggleText={t("modules.all", { count: modules.all.length })} style={{ marginTop: "0.5rem" }}>
        <SearchInput
          aria-label={t("modules.filter")}
          placeholder={t("modules.filter")}
          value={filter}
          onChange={(_e, v) => setFilter(v)}
          onClear={() => setFilter("")}
          style={{ marginBottom: "0.5rem" }}
        />
        <div style={{ maxHeight: "16rem", overflow: "auto", fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "0.85rem" }}>
          {shown.length ? shown.map(id => <div key={id}>{id}</div>) : <span>{t("modules.no_match")}</span>}
        </div>
      </ExpandableSection>
      {modules.nonStandard !== undefined && (
        <HelperText style={{ marginTop: "0.5rem" }}>
          <HelperTextItem>{t("modules.non_standard", { count: modules.nonStandard })}</HelperTextItem>
        </HelperText>
      )}
    </>
  );
}
