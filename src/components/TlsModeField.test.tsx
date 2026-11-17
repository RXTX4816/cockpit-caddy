import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TlsModeField, defaultTlsMode, tlsModeOf, tlsModeToEntry, hasPublicName } from "./TlsModeField";

// #246: pick where the certificate comes from instead of a "self-signed" checkbox.
describe("TLS mode (#246)", () => {
  it("defaults to automatic HTTPS for a public name and to the internal CA otherwise", () => {
    expect(defaultTlsMode("app.example.com")).toBe("acme");
    expect(defaultTlsMode("example.com, www.example.com")).toBe("acme");
    expect(defaultTlsMode("")).toBe("internal");
    expect(defaultTlsMode("192.168.1.5")).toBe("internal");
    expect(defaultTlsMode("localhost")).toBe("internal");
    expect(defaultTlsMode("nas.local")).toBe("internal");
    // A wildcard needs the DNS challenge for ACME, which the plugin doesn't set up.
    expect(defaultTlsMode("*.example.com")).toBe("internal");
    expect(hasPublicName("*.example.com")).toBe(true);
  });

  it("reads the mode of an existing site", () => {
    expect(tlsModeOf({ tls: false })).toBe("off");
    expect(tlsModeOf({ tls: true, tlsIssuer: "acme" })).toBe("acme");
    expect(tlsModeOf({ tls: true, tlsIssuer: "internal" })).toBe("internal");
    expect(tlsModeOf({ tls: true })).toBe("internal");
  });

  it("maps a mode to the entry fields, never ACME without a public name", () => {
    expect(tlsModeToEntry("acme", "app.example.com")).toEqual({ tls: true, tlsIssuer: "acme" });
    expect(tlsModeToEntry("acme", "")).toEqual({ tls: true, tlsIssuer: "internal" });
    expect(tlsModeToEntry("internal", "app.example.com")).toEqual({ tls: true, tlsIssuer: "internal" });
    expect(tlsModeToEntry("off", "app.example.com")).toEqual({ tls: false, tlsIssuer: undefined });
  });

  it("knows which host fields have a public name", () => {
    expect(hasPublicName("a.example.com")).toBe(true);
    expect(hasPublicName(undefined)).toBe(false);
  });

  it("offers ACME only with a public name and reports the choice", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TlsModeField id="m" value="internal" onChange={onChange} publicName={false} />);
    const select = screen.getByLabelText("HTTPS certificate");
    expect(screen.getByRole("option", { name: "Automatic (Let's Encrypt / ACME)" }).hasAttribute("disabled")).toBe(true);
    rerender(<TlsModeField id="m" value="internal" onChange={onChange} publicName />);
    fireEvent.change(select, { target: { value: "acme" } });
    expect(onChange).toHaveBeenCalledWith("acme");
  });
});
