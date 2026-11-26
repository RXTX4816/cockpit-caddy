import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { CaddyModulesPanel } from "./CaddyModulesPanel";
import { resetCaddyModulesCache } from "../api/caddyModules";
import { setCaddyManaged } from "../api/caddy";
import { mockSpawn } from "../test/setup";

describe("CaddyModulesPanel (#343)", () => {
  let host: FakeHost;
  beforeEach(() => { host = installFakeHost({}); resetCaddyModulesCache(); });
  afterEach(() => resetHost());

  it("lists what the installed Caddy has and what it lacks, and filters the modules", async () => {
    host.onRun(["caddy", "list-modules"], "dns.providers.cloudflare\nhttp.handlers.reverse_proxy\nhttp.handlers.rate_limit\n\n  Standard modules: 1\n  Non-standard modules: 2\n");
    render(<CaddyModulesPanel />);
    await waitFor(() => expect(screen.getByText("DNS challenge providers")).toBeTruthy());
    expect(screen.getByText("Rate limiting").closest("div")?.textContent).toContain("Installed");
    expect(screen.getByText("Layer 4 (TCP and UDP proxying)").closest("div")?.textContent).toContain("Not installed");
    expect(screen.getByText(/Providers: 1/)).toBeTruthy();
    expect(screen.getByText(/Modules that are not part of Caddy itself: 2/)).toBeTruthy();
    fireEvent.click(screen.getByText("All modules (3)"));
    fireEvent.change(screen.getByLabelText("Filter modules"), { target: { value: "rate" } });
    expect(screen.getByText("http.handlers.rate_limit")).toBeTruthy();
    expect(screen.queryByText("http.handlers.reverse_proxy")).toBeNull();
  });

  it("says so when the modules cannot be read", async () => {
    host.onRun(["caddy", "list-modules"], () => { throw new Error("not found"); });
    render(<CaddyModulesPanel />);
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
  });

  it("shows what the Admin API probes found for a Caddy without the caddy command", async () => {
    setCaddyManaged(false);
    // Caddy's /adapt: only the cloudflare provider and layer4 adapt, rate_limit can't be told.
    mockSpawn.mockImplementation((args: string[]) => {
      const body = args[args.indexOf("-d") + 1] ?? "";
      if (/acme_dns cloudflare|layer4/.test(body)) return Promise.resolve('{"result":{}}\n200');
      if (/rate_limit/.test(body)) return Promise.reject(new Error("curl failed"));
      return Promise.resolve('{"error":"adapting config using caddyfile adapter: unrecognized global option: x"}\n400');
    });
    try {
      render(<CaddyModulesPanel />);
      await waitFor(() => expect(screen.getByText("DNS challenge providers")).toBeTruthy());
      expect(screen.getByText("Layer 4 (TCP and UDP proxying)").closest("div")?.textContent).toContain("Installed");
      expect(screen.getByText("Rate limiting").closest("div")?.textContent).toContain("Not known");
      expect(screen.getByText("caddy-security (authentication portal)").closest("div")?.textContent).toContain("Not installed");
      expect(screen.getByText(/only reachable over the Admin API/)).toBeTruthy();
    } finally {
      setCaddyManaged(true);
      mockSpawn.mockReset();
    }
  });
});
