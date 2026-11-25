import type { ReactNode } from "react";
import { AccessLogSection, accessLogHasError, accessLogValuesToConfig, type AccessLogValues } from "./AccessLogSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { ServerTimeoutsSection, serverExtrasFromValues, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { TlsSection, tlsValuesHaveErrors, tlsValuesToAdvanced, tlsValuesToMtls, type TlsValues } from "./TlsSection";
import { ProxyDialogTabs, type ProxyTab, type ProxyTabKey } from "./proxyDialogParts";
import type { TabFlags } from "./proxyTabFlags";
import type { ErrorHandlerConfig } from "../api";

/** What the named-server dialogs' tabs (#344) look at, minus General's own fields. */
export interface ServerTabValues {
  tlsValues: TlsValues;
  accessLog: AccessLogValues;
  errorHandlers: ErrorHandlerConfig[];
  serverTimeouts: ServerTimeoutValues;
}

/** Which of the server dialog's tabs hold something configured or an error. */
export function serverTabFlags(v: ServerTabValues, generalHasError: boolean): TabFlags {
  const st = v.serverTimeouts;
  return {
    configured: {
      general: false,
      tree: false,
      security: !!(tlsValuesToAdvanced(v.tlsValues) || tlsValuesToMtls(v.tlsValues)),
      routing: false,
      upstreams: false,
      logging: !!accessLogValuesToConfig(v.accessLog) || v.errorHandlers.length > 0,
      limits: !!(st.readTimeout || st.readHeaderTimeout || st.writeTimeout || st.idleTimeout || st.maxHeaderBytes || st.disableHttp3) || !!serverExtrasFromValues(st),
    },
    hasError: {
      general: generalHasError,
      tree: false,
      security: tlsValuesHaveErrors(v.tlsValues),
      routing: false,
      upstreams: false,
      logging: accessLogHasError(v.accessLog),
      limits: false,
    },
  };
}

interface Props extends ServerTabValues {
  general: ReactNode;
  generalHasError: boolean;
  active: ProxyTabKey;
  onSelect: (k: ProxyTabKey) => void;
  isDisabled: boolean;
  hostless: boolean;
  onChange: (patch: Partial<ServerTabValues>) => void;
}

/** General, Security (TLS), Logging & errors and Limits of the Add and Edit server dialogs (#344). */
export function ServerDialogTabs({ general, generalHasError, active, onSelect, isDisabled, hostless, onChange, ...values }: Props) {
  const flags = serverTabFlags(values, generalHasError);
  const tabs: ProxyTab[] = [
    { key: "general", hasError: flags.hasError.general, content: general },
    {
      key: "security",
      configured: flags.configured.security,
      hasError: flags.hasError.security,
      content: <TlsSection value={values.tlsValues} onChange={v => onChange({ tlsValues: v })} isDisabled={isDisabled} hostless={hostless} />,
    },
    {
      key: "logging",
      configured: flags.configured.logging,
      content: (
        <>
          <AccessLogSection value={values.accessLog} onChange={v => onChange({ accessLog: v })} isDisabled={isDisabled} />
          <ErrorHandlersSection value={values.errorHandlers} onChange={v => onChange({ errorHandlers: v })} isDisabled={isDisabled} />
        </>
      ),
    },
    {
      key: "limits",
      configured: flags.configured.limits,
      content: <ServerTimeoutsSection value={values.serverTimeouts} onChange={v => onChange({ serverTimeouts: v })} isDisabled={isDisabled} />,
    },
  ];
  return <ProxyDialogTabs active={active} onSelect={onSelect} tabs={tabs} />;
}
