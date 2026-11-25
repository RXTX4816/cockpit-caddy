import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  listConfDFiles: vi.fn(async () => [
    "/etc/caddy/conf.d/cockpit-caddy-servers.json",
    "/etc/caddy/conf.d/cockpit-caddy.conf",
  ]),
  validateCaddyfile: vi.fn(),
  reloadCaddy: vi.fn(),
  applyCurrentCaddyfileViaApi: vi.fn(),
  isCaddyManaged: vi.fn(async () => true),
  readFile: vi.fn(async () => "example.com {\n}\n"),
  writeFile: vi.fn(),
}));

// Only CodeEditor is used from this module; a stub keeps CodeMirror out of jsdom.
vi.mock("@rxtx4816/cockpit-plugin-base-react/components", () => ({
  CodeEditor: ({ content }: { content: string }) => <pre>{content}</pre>,
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { CaddyfileEditor } from "./CaddyfileEditor";

const BLOCK_NOTE = /rewrites the block that holds it/i;

describe("CaddyfileEditor (#237)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders every file as a toggle with the selected one pressed", async () => {
    render(<CaddyfileEditor />);

    const conf = await screen.findByRole("button", { name: "conf.d/cockpit-caddy.conf" });
    const main = screen.getByRole("button", { name: "Caddyfile" });

    expect(main).toHaveAttribute("aria-pressed", "true");
    expect(conf).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(conf);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "conf.d/cockpit-caddy.conf" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByRole("button", { name: "Caddyfile" })).toHaveAttribute("aria-pressed", "false");
  });

  it("explains on cockpit-caddy.conf that only the saved proxy's block is rewritten", async () => {
    render(<CaddyfileEditor />);
    expect(screen.queryByText(BLOCK_NOTE)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "conf.d/cockpit-caddy.conf" }));

    expect(await screen.findByText(BLOCK_NOTE)).toBeInTheDocument();
  });

  it("doesn't show the block note on the legacy server-definitions JSON file", async () => {
    render(<CaddyfileEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "conf.d/cockpit-caddy-servers.json" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "conf.d/cockpit-caddy-servers.json" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByText(BLOCK_NOTE)).not.toBeInTheDocument();
  });
});
