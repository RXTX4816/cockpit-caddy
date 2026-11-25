import type { ReactNode } from "react";
import { Checkbox } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { isPathOnlyMatcher } from "../api";
import { AccessLogSection } from "./AccessLogSection";
import { BindSection } from "./BindSection";
import { EncodeSection } from "./EncodeSection";
import { BasicAuthSection } from "./BasicAuthSection";
import { DynamicUpstreamsSection } from "./DynamicUpstreamsSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { ForwardAuthSection, validateForwardAuth } from "./ForwardAuthSection";
import { LbRetrySection } from "./LbRetrySection";
import { RequestBodyLimitField } from "./RequestBodyLimitField";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { RewriteSection } from "./RewriteSection";
import { RouteMatchersSection } from "./RouteMatchersSection";
import { ServerTimeoutsSection } from "./ServerTimeoutsSection";
import { TlsSection } from "./TlsSection";
import { TransportSection } from "./TransportSection";
import { UpstreamsSection } from "./UpstreamsSection";
import { SiteTreeTab } from "./SiteTreeView";
import { Notice } from "./Notice";
import { hasNestedBlocks } from "../api/siteTree";
import { NamedRouteField, ProxyDialogTabs, type ProxyTab, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabStateFlags, type ProxyTabState, type ProxyTabStateUpdate, type ProxyTabsLayout } from "./proxyTabState";

interface Props {
  state: ProxyTabState;
  onChange: ProxyTabStateUpdate;
  /** The General tab's form; it differs between Add and Edit. */
  general: ReactNode;
  generalHasError: boolean;
  active: ProxyTabKey;
  onSelect: (k: ProxyTabKey) => void;
  isDisabled: boolean;
  /** e.g. "add-proxy" or "edit-static": keeps the field ids of the dialogs apart. */
  idPrefix: string;
  layout?: ProxyTabsLayout;
  /** TLS settings belong to the site; a route on a named server has none of its own. */
  showTls?: boolean;
  /** The site address has no host, so TLS Policy explains that its settings reach other hostless sites too. */
  hostless?: boolean;
  /** The site's block as written in conf.d. With route or nested handle blocks in it, a Tree tab shows them (#349). */
  siteText?: string;
  /** Saves the text the Tree tab made (#350); without it the tab is read-only. */
  onSaveSiteText?: (text: string, expected: string) => Promise<void>;
}

/** The site dialogs' tabs (#260), shared by Add, Edit and Duplicate (#290) of every site type (#293). */
export function ProxyTabs({ state: s, onChange, general, generalHasError, active, onSelect, isDisabled, idPrefix, layout = "proxy", showTls = false, hostless = false, siteText, onSaveSiteText }: Props) {
  const { t } = useTranslation();
  const flags = proxyTabStateFlags(s, generalHasError, layout);
  const forwardAuthErr = validateForwardAuth(s.forwardAuth);
  const isProxy = layout === "proxy";
  // A site with route or nested handle blocks (#348): the form saves only its address, bind,
  // imports and TLS, so every other field is locked instead of dropping what is typed in it.
  const nested = !!siteText && hasNestedBlocks(siteText);
  const locked = isDisabled || nested;
  const lockedNote = nested ? <Notice variant="info" isPlain title={t("tree.form_locked")} /> : null;

  const routeMatchers = (
    <>
      <RouteMatchersSection
        value={s.matchers}
        onChange={v => onChange(isPathOnlyMatcher(v) ? { matchers: v } : { matchers: v, handlePath: false })}
        isDisabled={locked}
      />
      {isPathOnlyMatcher(s.matchers) && (
        <Checkbox
          id={`${idPrefix}-handle-path`}
          label={t("handle_path.label")}
          isChecked={s.handlePath}
          onChange={(_e, v) => onChange({ handlePath: v })}
          isDisabled={locked}
        />
      )}
    </>
  );

  const tabs: ProxyTab[] = [{ key: "general", hasError: flags.hasError.general, content: general }];
  if (layout === "route") {
    tabs.push({ key: "routing", configured: flags.configured.routing, hasError: flags.hasError.routing, content: routeMatchers });
  } else {
    tabs.push(
      {
        key: "security",
        configured: flags.configured.security,
        hasError: flags.hasError.security,
        content: (
          <>
            {lockedNote}
            <BasicAuthSection value={s.basicAuth} onChange={v => onChange({ basicAuth: v })} options={s.basicAuthOptions} onOptionsChange={v => onChange({ basicAuthOptions: v })} isDisabled={locked} />
            {isProxy && (
              <ForwardAuthSection value={s.forwardAuth} onChange={v => onChange({ forwardAuth: v })} isDisabled={locked} uriError={forwardAuthErr ?? undefined} />
            )}
            {showTls && (
              <TlsSection value={s.tlsValues} onChange={v => onChange({ tlsValues: v })} isDisabled={isDisabled} hostless={hostless} />
            )}
          </>
        ),
      },
      {
        key: "routing",
        configured: flags.configured.routing,
        hasError: flags.hasError.routing,
        content: (
          <>
            {lockedNote}
            {routeMatchers}
            {isProxy && <RewriteSection value={s.rewrite} onChange={v => onChange({ rewrite: v })} isDisabled={locked} />}
            <RequestHeadersSection value={s.requestHeaders} onChange={v => onChange({ requestHeaders: v })} isDisabled={locked} />
            {isProxy && <RequestHeadersSection variant="down" value={s.upstreamResponseHeaders} onChange={v => onChange({ upstreamResponseHeaders: v })} isDisabled={locked} />}
            <ResponseHeadersSection value={s.responseHeaders} onChange={v => onChange({ responseHeaders: v })} isDisabled={locked} />
            <EncodeSection value={s.encode} onChange={v => onChange({ encode: v })} isDisabled={locked} />
            {isProxy && (
              <NamedRouteField
                idPrefix={`${idPrefix}-`}
                enabled={s.isNamedRoute}
                onEnabledChange={v => onChange({ isNamedRoute: v })}
                name={s.namedRouteName}
                onNameChange={v => onChange({ namedRouteName: v })}
                isDisabled={locked}
              />
            )}
          </>
        ),
      },
    );
    if (isProxy) {
      tabs.push({
        key: "upstreams",
        configured: flags.configured.upstreams,
        hasError: flags.hasError.upstreams,
        content: (
          <>
            {lockedNote}
            <UpstreamsSection value={s.extraUpstreams} lbPolicy={s.lbPolicy} onChange={(u, p) => onChange({ extraUpstreams: u, lbPolicy: p })} lbArgs={s.lbArgs} onLbArgsChange={a => onChange({ lbArgs: a })} isDisabled={locked} />
            <DynamicUpstreamsSection value={s.dynamicUpstreams} onChange={v => onChange({ dynamicUpstreams: v })} isDisabled={locked} />
            <LbRetrySection value={s.lbRetry} onChange={v => onChange({ lbRetry: v })} isDisabled={locked} />
            <TransportSection value={s.transport} onChange={v => onChange({ transport: v })} isDisabled={locked} />
          </>
        ),
      });
    }
    tabs.push(
      {
        key: "logging",
        configured: flags.configured.logging,
        content: (
          <>
            {lockedNote}
            <AccessLogSection value={s.accessLog} onChange={v => onChange({ accessLog: v })} isDisabled={locked} showSkipPaths={showTls} />
            <ErrorHandlersSection
              value={s.errorHandlers}
              onChange={v => onChange({ errorHandlers: v })}
              isDisabled={locked}
              {...(isProxy ? { replaceUpstream: s.replaceUpstreamErrors, onReplaceUpstreamChange: (v: boolean) => onChange({ replaceUpstreamErrors: v }) } : {})}
            />
          </>
        ),
      },
      {
        key: "limits",
        configured: flags.configured.limits,
        hasError: flags.hasError.limits,
        content: (
          <>
            <ServerTimeoutsSection value={s.serverTimeouts} onChange={v => onChange({ serverTimeouts: v })} isDisabled={isDisabled} />
            <BindSection value={s.bind} onChange={v => onChange({ bind: v })} isDisabled={isDisabled} idPrefix={`${idPrefix}-`} />
            <RequestBodyLimitField value={s.requestBodyMaxSize} onChange={v => onChange({ requestBodyMaxSize: v })} isDisabled={locked} idPrefix={idPrefix} />
          </>
        ),
      },
    );
  }

  if (siteText && hasNestedBlocks(siteText)) tabs.push({ key: "tree", content: <SiteTreeTab siteText={siteText} onSave={onSaveSiteText} /> });

  return <ProxyDialogTabs active={active} onSelect={onSelect} tabs={tabs} />;
}
