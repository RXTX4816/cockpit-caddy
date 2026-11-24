/** Caddy log lines (#257), parsed once per line for the Logs tab's table and filters. */

export interface ParsedLogLine {
  ts?: Date;
  level?: string;
  logger?: string;
  msg?: string;
  /** Access logs (`http.log.access.*`) only. */
  host?: string;
  method?: string;
  uri?: string;
  status?: number;
  raw: string;
  /** The JSON object when the line is Caddy's JSON format. */
  json?: Record<string, unknown>;
}

export type LevelFilter = "all" | "error" | "warn" | "info";

/** Caddy's stable namespace for HTTP access logs. */
export const ACCESS_LOG_PREFIX = "http.log.access.";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function toDate(v: unknown): Date | undefined {
  // Caddy writes `ts` as fractional Unix seconds by default, or as a string with time_format.
  const d = typeof v === "number" ? new Date(Math.round(v * 1000)) : typeof v === "string" ? new Date(v) : undefined;
  return d && !isNaN(d.getTime()) ? d : undefined;
}

/**
 * Parses one log line. Handles, after an optional journalctl "TIMESTAMP HOST UNIT[PID]: " prefix:
 *   JSON:    {"level":"info","ts":1700000000.1,"logger":"http","msg":"..."}
 *   Console: 2006/01/02 15:04:05.000  LEVEL  logger.name  message ...
 * journalctl --output=short-iso expands tabs to spaces, so the console format is matched on
 * whitespace. Anything else comes back as a row with the raw text as its message.
 */
export function parseCaddyLogLine(line: string): ParsedLogLine {
  const prefixMatch = line.match(/\[\d+\]: (.*)/s);
  const payload = (prefixMatch ? prefixMatch[1] : line).trimStart();

  if (payload.startsWith("{")) {
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const logger = str(obj.logger);
        const parsed: ParsedLogLine = { raw: line, json: obj, ts: toDate(obj.ts), level: str(obj.level)?.toLowerCase(), logger, msg: str(obj.msg) };
        if (logger?.startsWith(ACCESS_LOG_PREFIX)) {
          const req = (obj.request && typeof obj.request === "object" ? obj.request : {}) as Record<string, unknown>;
          parsed.host = str(req.host);
          parsed.method = str(req.method);
          parsed.uri = str(req.uri);
          if (typeof obj.status === "number") parsed.status = obj.status;
        }
        for (const k of Object.keys(parsed) as (keyof ParsedLogLine)[]) if (parsed[k] === undefined) delete parsed[k];
        return parsed;
      }
    } catch {
      // not JSON after all; fall through to the raw row
    }
  }

  const m = payload.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})[ \t]+([A-Z]+)[ \t]+(\S+)(?:[ \t]+(.*))?$/s);
  if (m) {
    const ts = toDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}`);
    return { raw: line, level: m[5].toLowerCase(), logger: m[6], msg: m[7] ?? "", ...(ts ? { ts } : {}) };
  }
  return { raw: line, msg: line };
}

/** The level chips are thresholds: "warn" includes errors, "info" every line (as before #257). */
export function matchesLevel(l: ParsedLogLine, filter: LevelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "info") return true;
  if (filter === "error") return l.level === "error";
  return l.level === "error" || l.level === "warn";
}

/** The logger tabs: "all", "caddy" (everything but access logs) or one access logger. */
export function matchesLogger(l: ParsedLogLine, tab: string): boolean {
  if (tab === "all") return true;
  if (tab === "caddy") return !l.logger?.startsWith(ACCESS_LOG_PREFIX);
  return l.logger === tab;
}

/**
 * Caddy logs every Admin API call as `admin.api` "received request" at info level, and the
 * plugin's own config poll is one of them (#284). The Logs tab hides these by default; other
 * `admin.api` lines (errors, config loads) are not requests and stay visible.
 */
export function isAdminApiRequest(l: ParsedLogLine): boolean {
  return l.logger === "admin.api" && l.msg === "received request";
}

/** Same rules as the base LogViewer's search: case-insensitive, on the raw line; a bad regex matches all. */
export function matchesSearch(l: ParsedLogLine, term: string, isRegex: boolean): boolean {
  if (!term) return true;
  try {
    return isRegex ? new RegExp(term, "i").test(l.raw) : l.raw.toLowerCase().includes(term.toLowerCase());
  } catch {
    return true;
  }
}
