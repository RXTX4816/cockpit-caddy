import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { probeUpstream } from "../api/probe";
import type { ProbeStatus } from "../api/probe";
import type { ProxyEntry } from "../api";

export type { ProbeStatus };

export type ProbeKey = string;

function collectTargets(proxies: ProxyEntry[]): Array<{ key: ProbeKey; scheme: "http" | "https"; host: string; port: number }> {
  const seen = new Set<string>();
  const result: Array<{ key: ProbeKey; scheme: "http" | "https"; host: string; port: number }> = [];
  for (const p of proxies) {
    if (p.redirect || p.fileServer) continue;
    const key = `${p.targetHost}:${p.targetPort}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ key, scheme: p.targetScheme, host: p.targetHost, port: p.targetPort });
    }
    for (const u of p.extraUpstreams ?? []) {
      const uKey = `${u.host}:${u.port}`;
      if (!seen.has(uKey)) {
        seen.add(uKey);
        result.push({ key: uKey, scheme: p.targetScheme, host: u.host, port: u.port });
      }
    }
  }
  return result;
}

function runProbeTargets(
  targets: ReturnType<typeof collectTargets>,
  setStatuses: Dispatch<SetStateAction<Map<ProbeKey, ProbeStatus>>>,
) {
  // Mark new targets as pending so dots appear before curl finishes
  setStatuses(prev => {
    const next = new Map(prev);
    for (const t of targets) {
      if (!next.has(t.key)) next.set(t.key, "pending");
    }
    return next;
  });
  for (const t of targets) {
    void probeUpstream(t).then(status => {
      setStatuses(prev => new Map(prev).set(t.key, status));
    });
  }
}

export interface UpstreamProbeResult {
  statuses: Map<ProbeKey, ProbeStatus>;
  /** Forces an immediate re-probe of all upstreams, bypassing the periodic interval. */
  refresh: () => void;
}

/**
 * Probes all proxy upstreams from the host via curl every 5 seconds.
 * Dots appear immediately as "pending" on enable; update to up/down after each curl.
 * File servers and redirects are excluded (no upstream to probe).
 */
export function useUpstreamProbe(proxies: ProxyEntry[], enabled: boolean): UpstreamProbeResult {
  const [statuses, setStatuses] = useState<Map<ProbeKey, ProbeStatus>>(new Map());

  // Stable string key — re-triggers the effect when the upstream set changes
  // (e.g. on initial proxy load after page refresh with monitor already enabled)
  const upstreamKey = proxies
    .filter(p => !p.redirect && !p.fileServer)
    .map(p => `${p.targetHost}:${p.targetPort}`)
    .sort()
    .join(",");

  // Keep a ref of latest proxies for the periodic timer callback
  const proxiesRef = useRef(proxies);
  useEffect(() => { proxiesRef.current = proxies; });

  // Re-probe whenever enabled or the upstream set changes
  useEffect(() => {
    if (!enabled) {
      setStatuses(new Map());
      return;
    }
    runProbeTargets(collectTargets(proxies), setStatuses);
    // upstreamKey acts as a proxy for proxies content changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, upstreamKey]);

  // Periodic refresh uses the ref so it always has fresh proxy data
  const periodicProbe = useCallback(() => {
    if (!enabled) return;
    runProbeTargets(collectTargets(proxiesRef.current), setStatuses);
  }, [enabled]);

  useAutoRefresh(periodicProbe, 5_000);

  return { statuses, refresh: periodicProbe };
}
