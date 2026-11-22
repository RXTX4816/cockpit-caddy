import { hasAnyMatcher } from "../api";
import type { ErrorHandlerConfig, ForwardAuthConfig, HeaderOperation, RewriteConfig, RouteMatch } from "../api";
import type { AccessLogValues } from "./AccessLogSection";
import { accessLogValuesToConfig } from "./AccessLogSection";
import type { AuthEntry } from "./BasicAuthSection";
import { lbRetryValuesToConfig, validateLbRetry, type LbRetryValues } from "./LbRetrySection";
import type { ServerTimeoutValues } from "./ServerTimeoutsSection";
import { tlsValuesHaveErrors, tlsValuesToAdvanced, tlsValuesToCustomTls, tlsValuesToMtls, type TlsValues } from "./TlsSection";
import type { TransportValues } from "./TransportSection";
import { validateUpstreams, type ExtraUpstream } from "./UpstreamsSection";
import type { ProxyTabKey } from "./proxyDialogParts";

/** Everything the proxy dialog's tabs (#260) look at, minus General's own fields. */
export interface ProxyTabValues {
  basicAuth: AuthEntry[];
  forwardAuth: ForwardAuthConfig | undefined;
  forwardAuthError: string | null;
  tlsValues: TlsValues;
  matchers: RouteMatch | undefined;
  rewrite: RewriteConfig | undefined;
  requestHeaders: HeaderOperation[] | undefined;
  responseHeaders: HeaderOperation[] | undefined;
  isNamedRoute: boolean;
  extraUpstreams: ExtraUpstream[];
  lbPolicy: string;
  lbRetry: LbRetryValues;
  transport: TransportValues;
  accessLog: AccessLogValues;
  errorHandlers: ErrorHandlerConfig[];
  serverTimeouts: ServerTimeoutValues;
  requestBodyMaxSize: string;
}

export interface TabFlags {
  configured: Record<ProxyTabKey, boolean>;
  hasError: Record<ProxyTabKey, boolean>;
}

/** Which tabs hold something other than the defaults, and which hold a validation error. */
export function proxyTabFlags(v: ProxyTabValues, generalHasError: boolean): TabFlags {
  const tls = !!(tlsValuesToAdvanced(v.tlsValues) || tlsValuesToMtls(v.tlsValues) || tlsValuesToCustomTls(v.tlsValues));
  const st = v.serverTimeouts;
  return {
    configured: {
      general: false,
      security: v.basicAuth.length > 0 || !!v.forwardAuth || tls,
      routing: hasAnyMatcher(v.matchers) || !!v.rewrite || !!v.requestHeaders?.length || !!v.responseHeaders?.length || v.isNamedRoute,
      upstreams: v.extraUpstreams.length > 0 || !!v.lbPolicy || !!lbRetryValuesToConfig(v.lbRetry) || !!(v.transport.dialTimeout || v.transport.responseHeaderTimeout),
      logging: !!accessLogValuesToConfig(v.accessLog) || v.errorHandlers.length > 0 || !!v.requestBodyMaxSize
        || !!(st.readTimeout || st.readHeaderTimeout || st.writeTimeout || st.idleTimeout || st.maxHeaderBytes || st.disableHttp3),
    },
    hasError: {
      general: generalHasError,
      security: !!v.forwardAuthError || tlsValuesHaveErrors(v.tlsValues),
      routing: false,
      upstreams: !!validateUpstreams(v.extraUpstreams) || !!validateLbRetry(v.lbRetry),
      logging: false,
    },
  };
}
