import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppFooter } from "./AppFooter";

describe("AppFooter", () => {
  it("shows the Caddy version once known", () => {
    render(<AppFooter caddyVersion="v2.10.0" />);
    expect(screen.getByText("Caddy v2.10.0")).toBeInTheDocument();
  });

  it("omits the Caddy version label while it is unknown", () => {
    render(<AppFooter caddyVersion={null} />);
    expect(screen.queryByText(/^Caddy /)).toBeNull();
  });

  it("links the wiki, the issue tracker and the source, each in a new tab", () => {
    render(<AppFooter />);
    const hrefs = Array.from(document.querySelectorAll("a")).map(a => a.getAttribute("href") ?? "");
    expect(hrefs.some(h => h.endsWith("/wiki"))).toBe(true);
    expect(hrefs.some(h => h.includes("/issues/"))).toBe(true);
    // AGPL §13: the running plugin must offer its Corresponding Source.
    expect(hrefs).toContain("https://github.com/RXTX4816/cockpit-caddy");
    for (const link of Array.from(document.querySelectorAll("a"))) {
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });

  it("keeps the licenses modal closed until the control is clicked", async () => {
    render(<AppFooter />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open source licenses" }));

    // The bundled packages' licenses have to be reachable from the served UI, not
    // only from THIRD-PARTY-NOTICES.txt on the server's disk.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/cockpit-caddy is licensed under AGPL-3\.0-only/)).toBeInTheDocument();
  });
});
