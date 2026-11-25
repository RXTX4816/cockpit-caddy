import { useCallback, useState } from "react";
import type { ErrorHandlerConfig, ForwardAuthConfig, HeaderOperation, LbPolicy, ProxyEntry, RewriteConfig, RouteMatch } from "../api";
import { accessLogConfigToValues, accessLogValuesToConfig, type AccessLogValues } from "./AccessLogSection";
import { resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { bindFromValue, bindToValue } from "./BindSection";
import { lbRetryConfigToValues, lbRetryValuesToConfig, type LbRetryValues } from "./LbRetrySection";
import type { ServerTimeoutValues } from "./ServerTimeoutsSection";
import { tlsConfigToValues, tlsValuesToAdvanced, tlsValuesToCustomTls, tlsValuesToMtls, type TlsValues } from "./TlsSection";
import type { TransportValues } from "./TransportSection";
import { emptyLbArgs, lbArgsFromValues, lbArgsToValues, type ExtraUpstream, type LbArgsValues } from "./UpstreamsSection";
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
  /** The policy's arguments (#285). */
  lbArgs: LbArgsValues;
  lbRetry: LbRetryValues;
  transport: TransportValues;
  accessLog: AccessLogValues;
  errorHandlers: ErrorHandlerConfig[];
  /** The error handlers also replace the upstream app's own error pages (#255). */
  replaceUpstreamErrors: boolean;
  serverTimeouts: ServerTimeoutValues;
  requestBodyMaxSize: string;
  /** The addresses the site binds to, as typed (#323). */
  bind: string;
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
    lbArgs: emptyLbArgs(),
    lbRetry: lbRetryConfigToValues(undefined),
    transport: { dialTimeout: "", responseHeaderTimeout: "" },
    accessLog: accessLogConfigToValues(undefined),
    errorHandlers: [],
    replaceUpstreamErrors: false,
    serverTimeouts: { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false },
    requestBodyMaxSize: "",
    bind: "",
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
    lbArgs: lbArgsToValues(p.lbPolicyArgs),
    lbRetry: lbRetryConfigToValues(p.lbRetry),
    transport: { dialTimeout: p.dialTimeout ?? "", responseHeaderTimeout: p.responseHeaderTimeout ?? "" },
    accessLog: accessLogConfigToValues(p.accessLog),
    errorHandlers: p.errorHandlers ?? [],
    replaceUpstreamErrors: p.replaceUpstreamErrors ?? false,
    serverTimeouts: {
      readTimeout: p.serverReadTimeout ?? "",
      readHeaderTimeout: p.serverReadHeaderTimeout ?? "",
      writeTimeout: p.serverWriteTimeout ?? "",
      idleTimeout: p.serverIdleTimeout ?? "",
      maxHeaderBytes: p.maxHeaderBytes != null ? String(p.maxHeaderBytes) : "",
      disableHttp3: p.disableHttp3 ?? false,
    },
    requestBodyMaxSize: p.requestBodyMaxSize != null ? String(p.requestBodyMaxSize) : "",
    bind: bindToValue(p.bind),
  };
}

export type ProxyTabEntryFields = Pick<ProxyEntry,
  | "basicAuth" | "forwardAuth" | "tlsAdvanced" | "mtls" | "customTls"
  | "matchers" | "handlePath" | "rewrite" | "requestHeaders" | "responseHeaders" | "isNamedRoute" | "namedRouteName"
  | "extraUpstreams" | "lbPolicy" | "lbPolicyArgs" | "lbRetry" | "dialTimeout" | "responseHeaderTimeout"
  | "accessLog" | "errorHandlers" | "replaceUpstreamErrors"
  | "serverReadTimeout" | "serverReadHeaderTimeout" | "serverWriteTimeout" | "serverIdleTimeout" | "maxHeaderBytes" | "disableHttp3"
  | "requestBodyMaxSize" | "bind">;

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
    lbPolicyArgs: s.extraUpstreams.length ? lbArgsFromValues(s.lbPolicy, s.lbArgs) : undefined,
    lbRetry: lbRetryValuesToConfig(s.lbRetry),
    dialTimeout: s.transport.dialTimeout.trim() || undefined,
    responseHeaderTimeout: s.transport.responseHeaderTimeout.trim() || undefined,
    accessLog: accessLogValuesToConfig(s.accessLog),
    errorHandlers: s.errorHandlers.length ? s.errorHandlers : undefined,
    replaceUpstreamErrors: (s.replaceUpstreamErrors && s.errorHandlers.length > 0) || undefined,
    serverReadTimeout: st.readTimeout.trim() || undefined,
    serverReadHeaderTimeout: st.readHeaderTimeout.trim() || undefined,
    serverWriteTimeout: st.writeTimeout.trim() || undefined,
    serverIdleTimeout: st.idleTimeout.trim() || undefined,
    maxHeaderBytes: st.maxHeaderBytes.trim() ? parseInt(st.maxHeaderBytes, 10) : undefined,
    disableHttp3: st.disableHttp3 || undefined,
    requestBodyMaxSize: s.requestBodyMaxSize.trim() ? parseInt(s.requestBodyMaxSize, 10) : undefined,
    bind: bindFromValue(s.bind),
  };
}

/**
 * Which tabs and sections a dialog shows (#293): "proxy" is the reverse proxy with everything;
 * "site" (static files, PHP) has no upstreams, forward auth, rewrite or named route; "route"
 * (redirect, respond) only has its route matchers next to General.
 */
export type ProxyTabsLayout = "proxy" | "site" | "route";

/** The state as the layout's sections see it: settings without a section count as unset. */
function visibleState(s: ProxyTabState, layout: ProxyTabsLayout): ProxyTabState {
  if (layout === "proxy") return s;
  const empty = emptyProxyTabState();
  if (layout === "route") return { ...empty, matchers: s.matchers, handlePath: s.handlePath };
  return {
    ...s,
    forwardAuth: empty.forwardAuth, rewrite: empty.rewrite, isNamedRoute: empty.isNamedRoute, namedRouteName: empty.namedRouteName,
    extraUpstreams: empty.extraUpstreams, lbPolicy: empty.lbPolicy, lbArgs: empty.lbArgs, lbRetry: empty.lbRetry, transport: empty.transport,
    replaceUpstreamErrors: empty.replaceUpstreamErrors,
  };
}

/**
 * Which tabs show the "configured" dot and which hold an error. Settings the layout has no
 * section for (a hand-written static site with forward auth) neither mark a tab nor block Save.
 */
export function proxyTabStateFlags(s: ProxyTabState, generalHasError: boolean, layout: ProxyTabsLayout = "proxy"): TabFlags {
  const v = visibleState(s, layout);
  return proxyTabFlags({ ...v, forwardAuthError: validateForwardAuth(v.forwardAuth) }, generalHasError);
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
