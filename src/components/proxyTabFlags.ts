import { hasAnyMatcher } from "../api";
import type { ErrorHandlerConfig, ForwardAuthConfig, LbPolicy, HeaderOperation, RewriteConfig, RouteMatch } from "../api";
import type { EncodeValues } from "./EncodeSection";
import { validateRewrite } from "./RewriteSection";
import { validateRouteMatch } from "./RouteMatchersSection";
import type { AccessLogValues } from "./AccessLogSection";
import { accessLogValuesToConfig, validateFieldFilters } from "./AccessLogSection";
import type { AuthEntry, BasicAuthOptionValues } from "./BasicAuthSection";
import { validateDynamicUpstreams, type DynamicSourceValues } from "./DynamicUpstreamsSection";
import { lbRetryValuesToConfig, validateLbRetry, type LbRetryValues } from "./LbRetrySection";
import type { ServerTimeoutValues } from "./ServerTimeoutsSection";
import { tlsValuesHaveErrors, tlsValuesToAdvanced, tlsValuesToCustomTls, tlsValuesToMtls, type TlsValues } from "./TlsSection";
import type { TransportValues } from "./TransportSection";
import { validateLbArgs, validateUpstreams, type ExtraUpstream, type LbArgsValues } from "./UpstreamsSection";
import type { ProxyTabKey } from "./proxyDialogParts";

/** Everything the proxy dialog's tabs (#260) look at, minus General's own fields. */
export interface ProxyTabValues {
  basicAuth: AuthEntry[];
  basicAuthOptions?: BasicAuthOptionValues;
  /** A kept account's hash was made with another algorithm than the one chosen (#337). */
  basicAuthError?: boolean;
  encode?: EncodeValues;
  /** The compression section holds a value Caddy would reject (#335). */
  encodeError?: boolean;
  forwardAuth: ForwardAuthConfig | undefined;
  forwardAuthError: string | null;
  tlsValues: TlsValues;
  matchers: RouteMatch | undefined;
  rewrite: RewriteConfig | undefined;
  requestHeaders: HeaderOperation[] | undefined;
  responseHeaders: HeaderOperation[] | undefined;
  upstreamResponseHeaders: HeaderOperation[] | undefined;
  isNamedRoute: boolean;
  extraUpstreams: ExtraUpstream[];
  dynamicUpstreams: DynamicSourceValues[];
  lbPolicy: string;
  lbArgs: LbArgsValues;
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
      tree: false,
      security: v.basicAuth.length > 0 || !!v.forwardAuth || tls,
      routing: hasAnyMatcher(v.matchers) || !!v.rewrite || !!v.requestHeaders?.length || !!v.responseHeaders?.length || !!v.upstreamResponseHeaders?.length || v.isNamedRoute
        || !!(v.encode && (v.encode.algorithms || v.encode.minimumLength || v.encode.matchStatus || v.encode.matchHeaders)),
      upstreams: v.extraUpstreams.length > 0 || v.dynamicUpstreams.length > 0 || !!v.lbPolicy || !!lbRetryValuesToConfig(v.lbRetry) || Object.values(v.transport).some(Boolean),
      logging: !!accessLogValuesToConfig(v.accessLog) || v.errorHandlers.length > 0,
      limits: !!v.requestBodyMaxSize
        || !!(st.readTimeout || st.readHeaderTimeout || st.writeTimeout || st.idleTimeout || st.maxHeaderBytes || st.disableHttp3 || st.keepaliveInterval || st.keepaliveIdle || st.readBodyIdle || st.strictSniHost || st.logCredentials || st.enableFullDuplex),
    },
    hasError: {
      general: generalHasError,
      tree: false,
      security: !!v.forwardAuthError || !!v.basicAuthError || tlsValuesHaveErrors(v.tlsValues),
      routing: !!v.encodeError || validateRewrite(v.rewrite) || validateRouteMatch(v.matchers),
      upstreams: !!validateUpstreams(v.extraUpstreams) || !!validateDynamicUpstreams(v.dynamicUpstreams) || !!validateLbRetry(v.lbRetry)
        || (v.extraUpstreams.length > 0 && !!validateLbArgs(v.lbPolicy as LbPolicy | "", v.lbArgs, v.extraUpstreams.length + 1)),
      logging: v.accessLog.enabled && validateFieldFilters(v.accessLog.fieldFilters),
      limits: false,
    },
  };
}
