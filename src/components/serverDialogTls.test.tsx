import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ServerDef } from "../api";
import { AddServerDialog } from "./AddServerDialog";
import { EditServerDialog } from "./EditServerDialog";

const def: ServerDef = { key: "web", name: "Web", listenAddresses: [":8443"], tls: true };

// Both the field label ("HTTPS") and the checkbox label name the input.
const httpsBox = () => screen.getByRole("checkbox", { name: /^HTTPS\s*On, with Caddy's internal CA$/ }) as HTMLInputElement;

// #294: the server dialogs keep their checkbox (a named server only listens on ports, so the
// internal CA is the only issuer it can use), with short wording out of the add_proxy strings.
describe("server dialogs: HTTPS checkbox (#294)", () => {
  it("Add Server labels it HTTPS, checked by default, without the old long label", () => {
    render(<AddServerDialog existingKeys={[]} onAdd={vi.fn()} onClose={() => {}} />);
    expect(httpsBox().checked).toBe(true);
    expect(screen.getByText("HTTPS")).toBeInTheDocument();
    expect(screen.getByText(/can't get an automatic \(ACME\) certificate/)).toBeInTheDocument();
    expect(screen.queryByText(/Enable TLS/)).not.toBeInTheDocument();
  });

  it("Edit Server shows the saved state and saves unchecked as tls: false", async () => {
    const onSave = vi.fn(async () => {});
    render(<EditServerDialog def={def} onSave={onSave} onClose={() => {}} />);
    expect(httpsBox().checked).toBe(true);
    fireEvent.click(httpsBox());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tls: false })));
  });

  it("Edit Server leaves it unchecked for a server without TLS", () => {
    render(<EditServerDialog def={{ ...def, tls: false }} onSave={vi.fn()} onClose={() => {}} />);
    expect(httpsBox().checked).toBe(false);
  });
});
