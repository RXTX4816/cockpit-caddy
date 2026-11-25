import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { CaddyModulesPanel } from "./CaddyModulesPanel";

describe("CaddyModulesPanel (#343)", () => {
  let host: FakeHost;
  beforeEach(() => { host = installFakeHost({}); });
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
});
