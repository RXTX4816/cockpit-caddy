import { describe, it, expect, beforeEach } from "vitest";
import { mockSpawn } from "../test/setup";
import {
  hostCertStatus, tlsLogEvents, certCovers, parseOpensslCertText,
  listStoredCertificates, readStoredCertificatePem, type StoredCert,
} from "./certStatus";

const DAY = 86_400_000;
const T0 = new Date("2026-11-01T00:00:00Z");

function cert(sans: string[], notBefore: Date, days: number, path = `/var/lib/caddy/certificates/x/${sans[0]}/${sans[0]}.crt`): StoredCert {
  return { path, sans, subject: `CN=${sans[0]}`, issuer: "CN=Test CA", notBefore, notAfter: new Date(notBefore.getTime() + days * DAY), fingerprint: "AA:BB" };
}

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("certCovers", () => {
  it("matches exact names and one-label wildcards", () => {
    expect(certCovers("a.example.com", "a.example.com")).toBe(true);
    expect(certCovers("*.example.com", "a.example.com")).toBe(true);
    expect(certCovers("*.example.com", "a.b.example.com")).toBe(false);
    expect(certCovers("*.example.com", "example.com")).toBe(false);
    expect(certCovers("A.Example.com", "a.example.COM")).toBe(true);
  });
});

describe("tlsLogEvents", () => {
  it("reads obtain/renew starts, successes and failures, and skips reload cancellations", () => {
    const events = tlsLogEvents([
      line({ level: "info", ts: 1, logger: "tls.obtain", msg: "obtaining certificate", identifier: "a.com" }),
      line({ level: "error", ts: 2, logger: "tls.obtain", msg: "could not get certificate from issuer", identifier: "a.com", error: "HTTP 400 rejectedIdentifier" }),
      line({ level: "error", ts: 3, logger: "tls", msg: "job failed", error: "a.com: obtaining certificate: context canceled" }),
      line({ level: "error", ts: 4, logger: "tls", msg: "job failed", error: "b.com: obtaining certificate: [b.com] solving challenges: timeout" }),
      line({ level: "info", ts: 5, logger: "tls.renew", msg: "renewing certificate", identifier: "c.com" }),
      line({ level: "info", ts: 6, logger: "tls.renew", msg: "certificate renewed successfully", identifier: "c.com" }),
      line({ level: "info", ts: 7, logger: "http", msg: "server running" }),
      "not json",
    ]);
    expect(events.map(e => [e.identifier, e.kind])).toEqual([
      ["a.com", "obtaining"], ["a.com", "error"], ["b.com", "error"], ["c.com", "obtaining"], ["c.com", "success"],
    ]);
    expect(events[1].error).toBe("HTTP 400 rejectedIdentifier");
    expect(events[2].error).toBe("obtaining certificate: [b.com] solving challenges: timeout");
  });
});

describe("hostCertStatus (#282)", () => {
  const now = new Date(T0.getTime() + 10 * DAY);

  it("valid: a stored certificate, with renewal at 1/3 lifetime left", () => {
    const s = hostCertStatus("a.com", [cert(["a.com"], T0, 90)], [], now);
    expect(s.state).toBe("valid");
    expect(s.notAfter).toEqual(new Date(T0.getTime() + 90 * DAY));
    expect(s.renewAt).toEqual(new Date(T0.getTime() + 60 * DAY));
    expect(s.cert?.path).toContain("a.com.crt");
  });

  it("renewal-due once the renewal date has passed and the old certificate is still stored", () => {
    const later = new Date(T0.getTime() + 61 * DAY);
    expect(hostCertStatus("a.com", [cert(["a.com"], T0, 90)], [], later).state).toBe("renewal-due");
  });

  it("uses the newest certificate when several cover the host", () => {
    const old = cert(["a.com"], new Date(T0.getTime() - 80 * DAY), 90, "/old.crt");
    const fresh = cert(["a.com"], T0, 90, "/new.crt");
    expect(hostCertStatus("a.com", [old, fresh], [], now).cert?.path).toBe("/new.crt");
  });

  it("obtaining: the latest log entry is a start with no later result", () => {
    const events = tlsLogEvents([line({ level: "info", ts: 1, logger: "tls.obtain", msg: "obtaining certificate", identifier: "a.com" })]);
    expect(hostCertStatus("a.com", [], events, now).state).toBe("obtaining");
  });

  it("failed: the latest entry is an error, with the message", () => {
    const events = tlsLogEvents([
      line({ level: "info", ts: 1, logger: "tls.obtain", msg: "obtaining certificate", identifier: "a.com" }),
      line({ level: "error", ts: 2, logger: "tls.obtain", msg: "could not get certificate from issuer", identifier: "a.com", error: "rate limited" }),
    ]);
    const s = hostCertStatus("a.com", [], events, now);
    expect(s.state).toBe("failed");
    expect(s.lastError).toBe("rate limited");
  });

  it("a later success falls back to the stored certificate", () => {
    const events = tlsLogEvents([
      line({ level: "error", ts: 1, logger: "tls.obtain", msg: "could not get certificate from issuer", identifier: "a.com", error: "x" }),
      line({ level: "info", ts: 2, logger: "tls.obtain", msg: "certificate obtained successfully", identifier: "a.com" }),
    ]);
    expect(hostCertStatus("a.com", [cert(["a.com"], T0, 90)], events, now).state).toBe("valid");
  });

  it("none: nothing stored and nothing logged", () => {
    expect(hostCertStatus("a.com", [cert(["b.com"], T0, 90)], [], now).state).toBe("none");
  });

  it("a wildcard certificate covers the host", () => {
    const s = hostCertStatus("app.example.com", [cert(["*.example.com"], T0, 90)], [], now);
    expect(s.state).toBe("valid");
    expect(s.cert?.sans).toEqual(["*.example.com"]);
  });

  it("log entries for a wildcard identifier count for the hosts it covers", () => {
    const events = tlsLogEvents([line({ level: "error", ts: 1, logger: "tls.obtain", msg: "could not get certificate from issuer", identifier: "*.example.com", error: "dns" })]);
    expect(hostCertStatus("*.example.com", [], events, now).state).toBe("failed");
  });
});

describe("parseOpensslCertText", () => {
  it("reads subject, issuer, dates, fingerprint and SANs", () => {
    const c = parseOpensslCertText("/p.crt", [
      "subject=CN = a.com",
      "issuer=C = US, O = Let's Encrypt, CN = R11",
      "notBefore=Nov  1 00:00:00 2026 GMT",
      "notAfter=Jan 30 00:00:00 2027 GMT",
      "sha256 Fingerprint=AB:CD:EF",
      "X509v3 Subject Alternative Name: ",
      "    DNS:a.com, DNS:www.a.com, IP Address:10.0.0.1",
    ].join("\n"));
    expect(c).toMatchObject({ path: "/p.crt", subject: "CN = a.com", issuer: "C = US, O = Let's Encrypt, CN = R11", fingerprint: "AB:CD:EF", sans: ["a.com", "www.a.com", "10.0.0.1"] });
    expect(c?.notAfter.toISOString()).toBe("2027-01-30T00:00:00.000Z");
  });
});

describe("storage access never touches private keys", () => {
  beforeEach(() => mockSpawn.mockReset());

  it("lists only .crt files and reads them with openssl", async () => {
    mockSpawn.mockImplementation(async (args?: string[]) => {
      if (args?.[0] === "find") return "/s/certificates/acme/a.com/a.com.crt\n";
      return "subject=CN = a.com\nissuer=CN = R11\nnotBefore=Nov  1 00:00:00 2026 GMT\nnotAfter=Jan 30 00:00:00 2027 GMT\nsha256 Fingerprint=AB\nX509v3 Subject Alternative Name: \n    DNS:a.com\n";
    });
    const certs = await listStoredCertificates("/s");
    expect(certs.map(c => c.sans)).toEqual([["a.com"]]);
    const argv = mockSpawn.mock.calls.filter(c => Array.isArray(c[0])).map(c => (c[0] as string[]).join(" "));
    expect(argv[0]).toContain("-name *.crt");
    expect(argv.join("\n")).not.toMatch(/\.key\b/);
  });

  it("refuses to read anything but a .crt under the storage's certificates", async () => {
    await expect(readStoredCertificatePem("/s", "/s/certificates/acme/a.com/a.com.key")).rejects.toThrow();
    await expect(readStoredCertificatePem("/s", "/etc/shadow.crt")).rejects.toThrow();
    await expect(readStoredCertificatePem("/s", "/s/certificates/../keys/x.crt")).rejects.toThrow();
    expect(mockSpawn).not.toHaveBeenCalled();
    mockSpawn.mockResolvedValue("-----BEGIN CERTIFICATE-----\n");
    await readStoredCertificatePem("/s", "/s/certificates/acme/a.com/a.com.crt");
    expect(mockSpawn.mock.calls[0][0]).toEqual(["cat", "--", "/s/certificates/acme/a.com/a.com.crt"]);
  });
});
