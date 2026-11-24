import { useCallback, useState } from "react";
import type { ErrorHandlerConfig, ForwardAuthConfig, HeaderOperation, LbPolicy, ProxyEntry, RewriteConfig, RouteMatch } from "../api";
import { accessLogConfigToValues, accessLogValuesToConfig, type AccessLogValues } from "./AccessLogSection";
import { resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { lbRetryConfigToValues, lbRetryValuesToConfig, type LbRetryValues } from "./LbRetrySection";
import type { ServerTimeoutValues } from "./ServerTimeoutsSection";
import { tlsConfigToValues, tlsValuesToAdvanced, tlsValuesToCustomTls, tlsValuesToMtls, type TlsValues } from "./TlsSection";
import type { TransportValues } from "./TransportSection";
import type { ExtraUpstream } from "./UpstreamsSection";
import { validateForwardAuth } from "./ForwardAuthSection";
import { proxyTabFlags, type TabFlags } from "./proxyTabFlags";

/**
 * Everything on the proxy dialog's Security / Routing / Upstreams / Logging tabs (#290), as one
 * value. Add, Edit and Duplicate build it the same way, so a new section is added once.
 */
export interface ProxyTabState {
  basicAuth: AuthEntry[];
  forwardAuth: ForwardAuthConfig | undefined;
  tlsValues: TlsValues;
  matchers: RouteMatch | undefined;
  handlePath: boolean;
  rewrite: RewriteConfig | undefined;
  requestHeaders: HeaderOperation[] | undefined;
  responseHeaders: HeaderOperation[] | undefined;
  isNamedRoute: boolean;
  namedRouteName: string;
  extraUpstreams: ExtraUpstream[];
  lbPolicy: LbPolicy | "";
  lbRetry: LbRetryValues;
  transport: TransportValues;
  accessLog: AccessLogValues;
  errorHandlers: ErrorHandlerConfig[];
  serverTimeouts: ServerTimeoutValues;
  requestBodyMaxSize: string;
}

export function emptyProxyTabState(): ProxyTabState {
  return {
    basicAuth: [],
    forwardAuth: undefined,
    tlsValues: tlsConfigToValues(undefined, undefined),
    matchers: undefined,
    handlePath: false,
    rewrite: undefined,
    requestHeaders: undefined,
    responseHeaders: undefined,
    isNamedRoute: false,
    namedRouteName: "",
    extraUpstreams: [],
    lbPolicy: "",
    lbRetry: lbRetryConfigToValues(undefined),
    transport: { dialTimeout: "", responseHeaderTimeout: "" },
    accessLog: accessLogConfigToValues(undefined),
    errorHandlers: [],
    serverTimeouts: { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false },
    requestBodyMaxSize: "",
  };
}

/** The tab state of an existing proxy (Edit, Duplicate). Passwords stay empty; their hashes are kept. */
export function proxyTabStateFromEntry(p: ProxyEntry): ProxyTabState {
  return {
    basicAuth: (p.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash })),
    forwardAuth: p.forwardAuth,
    tlsValues: tlsConfigToValues(p.tlsAdvanced, p.mtls, p.customTls),
    matchers: p.matchers,
    handlePath: p.handlePath ?? false,
    rewrite: p.rewrite,
    requestHeaders: p.requestHeaders,
    responseHeaders: p.responseHeaders,
    isNamedRoute: p.isNamedRoute ?? false,
    namedRouteName: p.namedRouteName ?? "",
    extraUpstreams: (p.extraUpstreams ?? []).map(u => ({ host: u.host, port: String(u.port) })),
    lbPolicy: p.lbPolicy ?? "",
    lbRetry: lbRetryConfigToValues(p.lbRetry),
    transport: { dialTimeout: p.dialTimeout ?? "", responseHeaderTimeout: p.responseHeaderTimeout ?? "" },
    accessLog: accessLogConfigToValues(p.accessLog),
    errorHandlers: p.errorHandlers ?? [],
    serverTimeouts: {
      readTimeout: p.serverReadTimeout ?? "",
      readHeaderTimeout: p.serverReadHeaderTimeout ?? "",
      writeTimeout: p.serverWriteTimeout ?? "",
      idleTimeout: p.serverIdleTimeout ?? "",
      maxHeaderBytes: p.maxHeaderBytes != null ? String(p.maxHeaderBytes) : "",
      disableHttp3: p.disableHttp3 ?? false,
    },
    requestBodyMaxSize: p.requestBodyMaxSize != null ? String(p.requestBodyMaxSize) : "",
  };
}

export type ProxyTabEntryFields = Pick<ProxyEntry,
  | "basicAuth" | "forwardAuth" | "tlsAdvanced" | "mtls" | "customTls"
  | "matchers" | "handlePath" | "rewrite" | "requestHeaders" | "responseHeaders" | "isNamedRoute" | "namedRouteName"
  | "extraUpstreams" | "lbPolicy" | "lbRetry" | "dialTimeout" | "responseHeaderTimeout"
  | "accessLog" | "errorHandlers"
  | "serverReadTimeout" | "serverReadHeaderTimeout" | "serverWriteTimeout" | "serverIdleTimeout" | "maxHeaderBytes" | "disableHttp3"
  | "requestBodyMaxSize">;

/** The ProxyEntry fields the tabs set; unset ones are undefined. Hashes new Basic Auth passwords. */
export async function proxyTabStateToEntry(s: ProxyTabState): Promise<ProxyTabEntryFields> {
  const st = s.serverTimeouts;
  return {
    basicAuth: s.basicAuth.length ? await resolveBasicAuth(s.basicAuth) : undefined,
    forwardAuth: s.forwardAuth ?? undefined,
    tlsAdvanced: tlsValuesToAdvanced(s.tlsValues),
    mtls: tlsValuesToMtls(s.tlsValues),
    customTls: tlsValuesToCustomTls(s.tlsValues),
    matchers: s.matchers ?? undefined,
    handlePath: s.handlePath || undefined,
    rewrite: s.rewrite ?? undefined,
    requestHeaders: s.requestHeaders ?? undefined,
    responseHeaders: s.responseHeaders ?? undefined,
    isNamedRoute: s.isNamedRoute || undefined,
    namedRouteName: (s.isNamedRoute && s.namedRouteName.trim()) ? s.namedRouteName.trim() : undefined,
    extraUpstreams: s.extraUpstreams.length
      ? s.extraUpstreams.map(u => ({ host: u.host.trim(), port: parseInt(u.port, 10) }))
      : undefined,
    lbPolicy: s.lbPolicy || undefined,
    lbRetry: lbRetryValuesToConfig(s.lbRetry),
    dialTimeout: s.transport.dialTimeout.trim() || undefined,
    responseHeaderTimeout: s.transport.responseHeaderTimeout.trim() || undefined,
    accessLog: accessLogValuesToConfig(s.accessLog),
    errorHandlers: s.errorHandlers.length ? s.errorHandlers : undefined,
    serverReadTimeout: st.readTimeout.trim() || undefined,
    serverReadHeaderTimeout: st.readHeaderTimeout.trim() || undefined,
    serverWriteTimeout: st.writeTimeout.trim() || undefined,
    serverIdleTimeout: st.idleTimeout.trim() || undefined,
    maxHeaderBytes: st.maxHeaderBytes.trim() ? parseInt(st.maxHeaderBytes, 10) : undefined,
    disableHttp3: st.disableHttp3 || undefined,
    requestBodyMaxSize: s.requestBodyMaxSize.trim() ? parseInt(s.requestBodyMaxSize, 10) : undefined,
  };
}

/** Which tabs show the "configured" dot and which hold an error. */
export function proxyTabStateFlags(s: ProxyTabState, generalHasError: boolean): TabFlags {
  return proxyTabFlags({ ...s, forwardAuthError: validateForwardAuth(s.forwardAuth) }, generalHasError);
}

export type ProxyTabStateUpdate = (patch: Partial<ProxyTabState>) => void;

/** The tab state with one setter that merges a patch. */
export function useProxyTabState(initial?: Partial<ProxyTabState>): [ProxyTabState, ProxyTabStateUpdate] {
  const [state, setState] = useState<ProxyTabState>(() => ({ ...emptyProxyTabState(), ...stripUndefined(initial) }));
  const update = useCallback<ProxyTabStateUpdate>(patch => setState(prev => ({ ...prev, ...patch })), []);
  return [state, update];
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
