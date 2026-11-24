import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TlsModeField, defaultTlsMode, tlsModeOf, tlsModeToEntry, hasPublicName } from "./TlsModeField";
import { useSiteDns } from "./SiteDnsChallenge";

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

describe("on-demand TLS per site (#253)", () => {
  it("shows the on-demand checkbox while TLS is on and reports changes", () => {
    const onOnDemandChange = vi.fn();
    const { rerender } = render(<TlsModeField id="m" value="acme" onChange={() => {}} publicName onDemand={false} onOnDemandChange={onOnDemandChange} />);
    fireEvent.click(screen.getByLabelText("On-demand: get the certificate at the first TLS handshake"));
    expect(onOnDemandChange).toHaveBeenCalledWith(true);
    rerender(<TlsModeField id="m" value="off" onChange={() => {}} publicName onDemand={false} onOnDemandChange={onOnDemandChange} />);
    expect(screen.queryByLabelText("On-demand: get the certificate at the first TLS handshake")).toBeNull();
  });
});

describe("per-site DNS challenge (#289)", () => {
  function stub(caddyfile: string, modules = "dns.providers.cloudflare\n") {
    vi.stubGlobal("cockpit", {
      spawn: (args: string[]) => {
        const p = args[0] === "caddy" ? Promise.resolve(modules) : Promise.reject(new Error("no such file"));
        return Object.assign(p, { input: () => {} });
      },
      file: (path: string) => ({ read: async () => (path === "/etc/caddy/Caddyfile" ? caddyfile : null) }),
    });
  }
  const NO_GLOBAL = "{\n}\n";
  const GLOBAL = "{\n\tacme_dns hetzner {\n\t\tapi_token {env.CADDY_DNS_API_TOKEN}\n\t}\n}\n";

  function Harness({ host, mode = "acme", initial }: { host: string; mode?: "acme" | "internal"; initial?: Parameters<typeof useSiteDns>[0] }) {
    const dns = useSiteDns(initial, mode === "acme");
    const plan = dns.plan(host, mode === "acme");
    return (
      <>
        <TlsModeField id="t" value={mode} onChange={() => {}} publicName dns={dns} host={host} />
        <output data-testid="plan">{JSON.stringify(plan)}</output>
        <output data-testid="error">{dns.error(host, mode === "acme") ?? ""}</output>
      </>
    );
  }

  it("shows the select only under automatic HTTPS, inheriting by default", async () => {
    stub(NO_GLOBAL);
    const { rerender } = render(<Harness host="a.example.com" />);
    expect(await screen.findByRole("option", { name: "Inherit global (none set: HTTP challenge)" })).toBeTruthy();
    expect((screen.getByLabelText("DNS challenge") as HTMLSelectElement).value).toBe("inherit");
    expect(JSON.parse(screen.getByTestId("plan").textContent!)).toEqual({ secrets: { set: {}, remove: [] } });
    rerender(<Harness host="a.example.com" mode="internal" />);
    expect(screen.queryByLabelText("DNS challenge")).toBeNull();
  });

  it("names the global provider when one is set", async () => {
    stub(GLOBAL);
    render(<Harness host="a.example.com" />);
    expect(await screen.findByRole("option", { name: "Inherit global (hetzner)" })).toBeTruthy();
  });

  it("warns for a wildcard that would fall back to the HTTP challenge", async () => {
    stub(NO_GLOBAL);
    render(<Harness host="*.example.com" />);
    expect(await screen.findByTestId("t-dns-wildcard-warning")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("DNS challenge"), { target: { value: "override" } });
    expect(screen.queryByTestId("t-dns-wildcard-warning")).toBeNull();
  });

  it("does not warn for a wildcard when a global provider is set", async () => {
    stub(GLOBAL);
    render(<Harness host="*.example.com" />);
    await screen.findByRole("option", { name: "Inherit global (hetzner)" });
    expect(screen.queryByTestId("t-dns-wildcard-warning")).toBeNull();
  });

  it("an override asks for a provider, then plans per-site variables with the value on the side", async () => {
    stub(NO_GLOBAL);
    render(<Harness host="a.example.com" />);
    fireEvent.change(await screen.findByLabelText("DNS challenge"), { target: { value: "override" } });
    expect(screen.getByTestId("error").textContent).toBe("dns.validation_provider");
    fireEvent.change(await screen.findByLabelText("DNS provider"), { target: { value: "cloudflare" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "tok" } });
    const plan = JSON.parse(screen.getByTestId("plan").textContent!);
    const [name] = Object.values(plan.config.credentials) as string[];
    expect(name).toMatch(/^CADDY_DNS_SITE_A_EXAMPLE_COM_[A-Z0-9]+_API_TOKEN$/);
    expect(plan.config).toEqual({ provider: "cloudflare", credentials: { api_token: name } });
    expect(plan.secrets).toEqual({ set: { [name]: "tok" }, remove: [] });
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("dropping an override, or leaving automatic HTTPS, removes the site's variables", async () => {
    stub(NO_GLOBAL);
    const initial = { provider: "cloudflare", credentials: { api_token: "CADDY_DNS_SITE_A_1_API_TOKEN" } };
    const { rerender } = render(<Harness host="a.example.com" initial={initial} />);
    expect((await screen.findByLabelText("DNS challenge") as HTMLSelectElement).value).toBe("override");
    rerender(<Harness host="a.example.com" mode="internal" initial={initial} />);
    expect(JSON.parse(screen.getByTestId("plan").textContent!).secrets.remove).toEqual(["CADDY_DNS_SITE_A_1_API_TOKEN"]);
  });
});
