import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlobalTlsFields, globalTlsFromValues, globalTlsToValues } from "./GlobalTlsFields";
import { GlobalAdminFields, globalAdminFromValues, globalAdminToValues } from "./GlobalAdminFields";

describe("GlobalTlsFields values (#329)", () => {
  it("maps the options to the form and back", () => {
    const opts = {
      autoHttps: "off", localCerts: true, defaultSni: "example.com", keyType: "p384", ocspStaplingOff: true, defaultBind: ["127.0.0.1", "[::1]"],
      preferredChains: { mode: "any_common_name" as const, names: ["A", "B C"] },
    };
    const back = globalTlsFromValues(globalTlsToValues(opts));
    expect(back).toEqual({ ...opts, certIssuer: undefined, certIssuerBody: undefined });
  });

  it("keeps a cert_issuer it has no field for, with its body", () => {
    const opts = { certIssuer: "zerossl", certIssuerBody: ["email me@example.com"] };
    const values = globalTlsToValues(opts);
    expect(values.issuer).toBe("custom");
    expect(globalTlsFromValues(values)).toMatchObject(opts);
  });

  it("reads a plain cert_issuer internal as the internal choice", () => {
    expect(globalTlsToValues({ certIssuer: "internal" }).issuer).toBe("internal");
    expect(globalTlsFromValues(globalTlsToValues({ certIssuer: "internal" })).certIssuer).toBe("internal");
  });

  it("writes nothing for an empty form", () => {
    expect(Object.values(globalTlsFromValues(globalTlsToValues({}))).every(v => v === undefined)).toBe(true);
  });

  it("changes the key type from the select", () => {
    const onChange = vi.fn();
    render(<GlobalTlsFields value={globalTlsToValues({})} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Key type"), { target: { value: "p256" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keyType: "p256" }));
  });
});

describe("GlobalAdminFields values (#330)", () => {
  it("maps the admin option to the form and back", () => {
    const opts = { adminAddress: "localhost:2019", adminOrigins: ["a.example", "b.example"], adminEnforceOrigin: true };
    expect(globalAdminFromValues(globalAdminToValues(opts))).toEqual(opts);
  });

  it("writes only admin off when it is off", () => {
    expect(globalAdminFromValues({ off: true, address: "localhost:2019", origins: "x", enforceOrigin: true })).toEqual({ adminOff: true });
  });

  it("disables the other fields while the admin endpoint is off", () => {
    render(<GlobalAdminFields value={globalAdminToValues({ adminOff: true })} onChange={() => {}} />);
    expect(screen.getByLabelText("Admin address")).toHaveProperty("disabled", true);
  });
});
