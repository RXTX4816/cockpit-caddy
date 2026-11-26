import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TlsSection, tlsConfigToValues, tlsValuesHaveErrors, tlsValuesToAdvanced } from "./TlsSection";

describe("a site's own ACME settings in the TLS section (#341)", () => {
  const adv = { acmeEmail: "me@example.com", acmeCa: "https://acme-staging-v02.api.letsencrypt.org/directory", keyType: "p256" };

  it("maps them to the form and back", () => {
    expect(tlsValuesToAdvanced(tlsConfigToValues(adv, undefined))).toEqual(expect.objectContaining(adv));
    expect(tlsValuesToAdvanced(tlsConfigToValues(undefined, undefined))).toBeUndefined();
  });

  it("drops them when a certificate is loaded, since nothing is issued then", () => {
    const values = { ...tlsConfigToValues(adv, undefined), customCertFile: "/a.pem", customKeyFile: "/a.key" };
    expect(tlsValuesToAdvanced(values)).toBeUndefined();
  });

  it("flags an email without an @ and a CA that is no URL", () => {
    expect(tlsValuesHaveErrors(tlsConfigToValues(adv, undefined))).toBe(false);
    expect(tlsValuesHaveErrors(tlsConfigToValues({ acmeEmail: "me" }, undefined))).toBe(true);
    expect(tlsValuesHaveErrors(tlsConfigToValues({ acmeCa: "acme.example.com" }, undefined))).toBe(true);
  });

  it("shows the fields, and not for a loaded certificate", () => {
    const { rerender } = render(<TlsSection value={tlsConfigToValues(adv, undefined)} onChange={() => {}} isExpanded />);
    expect(screen.getByLabelText("ACME email")).toBeTruthy();
    expect(screen.getByLabelText("ACME CA directory URL")).toBeTruthy();
    expect(screen.getByLabelText("Key type")).toBeTruthy();
    rerender(<TlsSection value={{ ...tlsConfigToValues(adv, undefined), customCertFile: "/a.pem", customKeyFile: "/a.key" }} onChange={() => {}} isExpanded />);
    expect(screen.queryByLabelText("ACME email")).toBeNull();
  });

  it("shows only the fields that apply to the site's certificate source", () => {
    const values = tlsConfigToValues(adv, undefined);
    const { rerender } = render(<TlsSection value={values} onChange={() => {}} isExpanded tlsMode="internal" />);
    expect(screen.queryByLabelText("ACME email")).toBeNull();
    expect(screen.queryByLabelText("ACME CA directory URL")).toBeNull();
    expect(screen.getByLabelText("Key type")).toBeTruthy();
    expect(screen.getByLabelText("Certificate lifetime")).toBeTruthy();

    rerender(<TlsSection value={values} onChange={() => {}} isExpanded tlsMode="acme" />);
    expect(screen.getByLabelText("ACME email")).toBeTruthy();
    expect(screen.queryByLabelText("Certificate lifetime")).toBeNull();
  });

  it("only says that HTTPS is off when the site serves plain HTTP", () => {
    render(<TlsSection value={tlsConfigToValues(adv, undefined)} onChange={() => {}} isExpanded tlsMode="off" hostless />);
    expect(screen.getByText(/HTTPS is off for this site/)).toBeTruthy();
    expect(screen.queryByLabelText("ACME email")).toBeNull();
    expect(screen.queryByLabelText("Key type")).toBeNull();
    expect(screen.queryByText("TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256")).toBeNull();
    expect(screen.queryByText(/has no hostname/)).toBeNull();
  });
});
