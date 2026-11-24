import { describe, it, expect, afterEach } from "vitest";
import { parseCertDetails } from "./caddy";
import { mockSpawn } from "../test/setup";
import { mockProcess } from "../test/helpers";

// #315: cockpit.spawn has no `input` option, so the PEM has to go to openssl's stdin.
describe("parseCertDetails", () => {
  afterEach(() => mockSpawn.mockReset());

  it("sends the PEM on stdin and reads the dates and fingerprint", async () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const proc = mockProcess(
      "notBefore=Nov 17 10:00:00 2026 GMT\nnotAfter=Sep 25 10:00:00 2036 GMT\nsha256 Fingerprint=AB:CD:EF\n",
    );
    mockSpawn.mockReturnValue(proc);
    expect(await parseCertDetails(pem)).toEqual({
      notBefore: "Nov 17 10:00:00 2026 GMT",
      notAfter: "Sep 25 10:00:00 2036 GMT",
      fingerprint: "AB:CD:EF",
    });
    expect(proc.input).toHaveBeenCalledWith(pem);
    const [argv, opts] = mockSpawn.mock.calls[0] as [string[], Record<string, unknown>];
    expect(argv).toEqual(["openssl", "x509", "-noout", "-dates", "-fingerprint", "-sha256"]);
    expect(opts).not.toHaveProperty("input");
  });
});
