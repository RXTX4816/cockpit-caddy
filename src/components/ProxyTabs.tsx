import type { ReactNode } from "react";
import { Checkbox } from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { isPathOnlyMatcher } from "../api";
import { AccessLogSection } from "./AccessLogSection";
import { BasicAuthSection } from "./BasicAuthSection";
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
}

/** The site dialogs' tabs (#260), shared by Add, Edit and Duplicate (#290) of every site type (#293). */
export function ProxyTabs({ state: s, onChange, general, generalHasError, active, onSelect, isDisabled, idPrefix, layout = "proxy", showTls = false, hostless = false }: Props) {
  const { t } = useTranslation();
  const flags = proxyTabStateFlags(s, generalHasError, layout);
  const forwardAuthErr = validateForwardAuth(s.forwardAuth);
  const isProxy = layout === "proxy";

  const routeMatchers = (
    <>
      <RouteMatchersSection
        value={s.matchers}
        onChange={v => onChange(isPathOnlyMatcher(v) ? { matchers: v } : { matchers: v, handlePath: false })}
        isDisabled={isDisabled}
      />
      {isPathOnlyMatcher(s.matchers) && (
        <Checkbox
          id={`${idPrefix}-handle-path`}
          label={t("handle_path.label")}
          isChecked={s.handlePath}
          onChange={(_e, v) => onChange({ handlePath: v })}
          isDisabled={isDisabled}
        />
      )}
    </>
  );

  const tabs: ProxyTab[] = [{ key: "general", hasError: flags.hasError.general, content: general }];
  if (layout === "route") {
    tabs.push({ key: "routing", configured: flags.configured.routing, content: routeMatchers });
  } else {
    tabs.push(
      {
        key: "security",
        configured: flags.configured.security,
        hasError: flags.hasError.security,
        content: (
          <>
            <BasicAuthSection value={s.basicAuth} onChange={v => onChange({ basicAuth: v })} isDisabled={isDisabled} />
            {isProxy && (
              <ForwardAuthSection value={s.forwardAuth} onChange={v => onChange({ forwardAuth: v })} isDisabled={isDisabled} uriError={forwardAuthErr ?? undefined} />
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
        content: (
          <>
            {routeMatchers}
            {isProxy && <RewriteSection value={s.rewrite} onChange={v => onChange({ rewrite: v })} isDisabled={isDisabled} />}
            <RequestHeadersSection value={s.requestHeaders} onChange={v => onChange({ requestHeaders: v })} isDisabled={isDisabled} />
            <ResponseHeadersSection value={s.responseHeaders} onChange={v => onChange({ responseHeaders: v })} isDisabled={isDisabled} />
            {isProxy && (
              <NamedRouteField
                idPrefix={`${idPrefix}-`}
                enabled={s.isNamedRoute}
                onEnabledChange={v => onChange({ isNamedRoute: v })}
                name={s.namedRouteName}
                onNameChange={v => onChange({ namedRouteName: v })}
                isDisabled={isDisabled}
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
            <UpstreamsSection value={s.extraUpstreams} lbPolicy={s.lbPolicy} onChange={(u, p) => onChange({ extraUpstreams: u, lbPolicy: p })} isDisabled={isDisabled} />
            <LbRetrySection value={s.lbRetry} onChange={v => onChange({ lbRetry: v })} isDisabled={isDisabled} />
            <TransportSection value={s.transport} onChange={v => onChange({ transport: v })} isDisabled={isDisabled} />
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
            <AccessLogSection value={s.accessLog} onChange={v => onChange({ accessLog: v })} isDisabled={isDisabled} />
            <ErrorHandlersSection value={s.errorHandlers} onChange={v => onChange({ errorHandlers: v })} isDisabled={isDisabled} />
          </>
        ),
      },
      {
        key: "limits",
        configured: flags.configured.limits,
        content: (
          <>
            <ServerTimeoutsSection value={s.serverTimeouts} onChange={v => onChange({ serverTimeouts: v })} isDisabled={isDisabled} />
            <RequestBodyLimitField value={s.requestBodyMaxSize} onChange={v => onChange({ requestBodyMaxSize: v })} isDisabled={isDisabled} idPrefix={idPrefix} />
          </>
        ),
      },
    );
  }

  return <ProxyDialogTabs active={active} onSelect={onSelect} tabs={tabs} />;
}
