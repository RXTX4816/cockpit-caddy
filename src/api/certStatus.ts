/**
 * Certificate status per host for the ACME window (#282): what Caddy has in storage, and what
 * its `tls` log says about obtaining or renewing. Only `.crt` files are ever read; the private
 * keys next to them in storage are never touched.
 */

export interface StoredCert {
  /** Path of the `.crt` file in Caddy's storage. */
  path: string;
  /** DNS names and IPs from subjectAltName (the CN when there is no SAN extension). */
  sans: string[];
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** SHA-256 fingerprint, colon-separated hex. */
  fingerprint: string;
}

export interface TlsLogEvent {
  ts?: Date;
  identifier: string;
  kind: "obtaining" | "success" | "error";
  error?: string;
}

export type CertState = "valid" | "renewal-due" | "obtaining" | "failed" | "none";

export interface HostCertStatus {
  host: string;
  state: CertState;
  notAfter?: Date;
  renewAt?: Date;
  /** The latest error, also while a new attempt is running. */
  lastError?: string;
  /** The stored certificate the status refers to. */
  cert?: StoredCert;
}

/** True when the certificate name `san` (exact, or a one-label `*.` wildcard) covers `host`. */
export function certCovers(san: string, host: string): boolean {
  const s = san.toLowerCase();
  const h = host.toLowerCase();
  if (s === h) return true;
  if (!s.startsWith("*.")) return false;
  const dot = h.indexOf(".");
  return dot > 0 && h.slice(dot + 1) === s.slice(2);
}

const START = /^(obtaining|renewing) certificate$/;
const SUCCESS = /^certificate (obtained|renewed) successfully$/;

/** The obtain / renew events in Caddy's JSON log lines, oldest first. Other lines are skipped. */
export function tlsLogEvents(lines: string[]): TlsLogEvent[] {
  const events: TlsLogEvent[] = [];
  for (const raw of lines) {
    const at = raw.indexOf("{");
    if (at < 0) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw.slice(at)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const logger = typeof o.logger === "string" ? o.logger : "";
    if (logger !== "tls" && !logger.startsWith("tls.")) continue;
    const msg = typeof o.msg === "string" ? o.msg : "";
    const ts = typeof o.ts === "number" ? new Date(Math.round(o.ts * 1000)) : undefined;
    const error = typeof o.error === "string" ? o.error : undefined;
    const identifier = typeof o.identifier === "string" ? o.identifier : undefined;

    if (identifier && START.test(msg)) events.push({ ts, identifier, kind: "obtaining" });
    else if (identifier && SUCCESS.test(msg)) events.push({ ts, identifier, kind: "success" });
    else if (identifier && o.level === "error") events.push({ ts, identifier, kind: "error", error: error ?? msg });
    else if (msg === "job failed" && error) {
      // `host: obtaining certificate: …`. A cancelled job is only a reload stopping it.
      const m = error.match(/^(\S+): (.*)$/s);
      if (m && !/context canceled$/.test(m[2])) events.push({ ts, identifier: m[1], kind: "error", error: m[2] });
    }
  }
  return events;
}

/** Caddy's default renewal point: when a third of the lifetime is left. */
function renewalDate(c: StoredCert): Date {
  const life = c.notAfter.getTime() - c.notBefore.getTime();
  return new Date(c.notAfter.getTime() - life / 3);
}

/** Maps the stored certificates and the tls log events to one host's status. */
export function hostCertStatus(host: string, certs: StoredCert[], events: TlsLogEvent[], now: Date): HostCertStatus {
  const mine = events.filter(e => certCovers(e.identifier, host) || e.identifier.toLowerCase() === host.toLowerCase());
  const latest = mine[mine.length - 1];
  const lastError = [...mine].reverse().find(e => e.kind === "error")?.error;

  if (latest?.kind === "error") return { host, state: "failed", lastError };
  if (latest?.kind === "obtaining") {
    const prev = mine[mine.length - 2];
    return { host, state: "obtaining", ...(prev?.kind === "error" ? { lastError } : {}) };
  }

  const cert = certs
    .filter(c => c.sans.some(s => certCovers(s, host)))
    .sort((a, b) => b.notAfter.getTime() - a.notAfter.getTime())[0];
  if (!cert) return { host, state: "none" };
  const renewAt = renewalDate(cert);
  return { host, state: now >= renewAt ? "renewal-due" : "valid", notAfter: cert.notAfter, renewAt, cert };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** openssl's `Nov  1 00:00:00 2026 GMT`. */
function parseOpensslDate(s: string): Date | undefined {
  const m = s.trim().match(/^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$/);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return undefined;
  return new Date(Date.UTC(+m[6], month, +m[2], +m[3], +m[4], +m[5]));
}

/** Parses `openssl x509 -noout -subject -issuer -dates -fingerprint -sha256 -ext subjectAltName`. */
export function parseOpensslCertText(path: string, out: string): StoredCert | undefined {
  const field = (name: string) => out.match(new RegExp(`^${name}=\\s*(.*)$`, "mi"))?.[1]?.trim();
  const notBefore = parseOpensslDate(field("notBefore") ?? "");
  const notAfter = parseOpensslDate(field("notAfter") ?? "");
  if (!notBefore || !notAfter) return undefined;
  const subject = field("subject") ?? "";
  const sanLine = out.match(/Subject Alternative Name:.*\n\s*(.+)/)?.[1] ?? "";
  let sans = sanLine.split(",").map(s => s.trim().replace(/^(DNS|IP Address):/, "")).filter(Boolean);
  if (!sans.length) {
    const cn = subject.match(/CN\s*=\s*([^,]+)/)?.[1]?.trim();
    sans = cn ? [cn] : [];
  }
  return {
    path,
    sans,
    subject,
    issuer: field("issuer") ?? "",
    notBefore,
    notAfter,
    fingerprint: field("sha256 Fingerprint") ?? "",
  };
}

/** Every certificate under `<storage>/certificates` (only `*.crt` files). */
export async function listStoredCertificates(storagePath: string): Promise<StoredCert[]> {
  let found: string;
  try {
    found = await cockpit.spawn(["find", `${storagePath}/certificates`, "-type", "f", "-name", "*.crt"], { superuser: "try", err: "ignore" });
  } catch {
    return [];
  }
  const paths = found.split("\n").map(p => p.trim()).filter(p => p.endsWith(".crt"));
  const certs = await Promise.all(paths.map(async p => {
    try {
      const out = await cockpit.spawn(
        ["openssl", "x509", "-in", p, "-noout", "-subject", "-issuer", "-dates", "-fingerprint", "-sha256", "-ext", "subjectAltName"],
        { superuser: "try", err: "ignore" },
      );
      return parseOpensslCertText(p, out);
    } catch {
      return undefined;
    }
  }));
  return certs.filter((c): c is StoredCert => !!c);
}

/** The PEM of one stored certificate. Refuses anything but a `.crt` file inside `<storage>/certificates`. */
export async function readStoredCertificatePem(storagePath: string, certPath: string): Promise<string> {
  const root = `${storagePath.replace(/\/+$/, "")}/certificates/`;
  if (!certPath.startsWith(root) || !certPath.endsWith(".crt") || certPath.split("/").includes("..")) {
    throw new Error(`not a stored certificate: ${certPath}`);
  }
  return cockpit.spawn(["cat", "--", certPath], { superuser: "try" });
}

/** Recent Caddy service log lines that came from the `tls` loggers. */
export async function fetchTlsLogLines(lines = 5000): Promise<string[]> {
  try {
    const out = await cockpit.spawn(
      ["journalctl", "-u", "caddy", "--output=cat", "--no-pager", "-n", String(lines)],
      { superuser: "try", err: "ignore" },
    );
    return out.split("\n").filter(l => l.includes('"logger":"tls'));
  } catch {
    return [];
  }
}
