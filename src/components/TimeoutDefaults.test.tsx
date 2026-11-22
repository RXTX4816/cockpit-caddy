import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { TransportSection } from "./TransportSection";

function applyDefaults() {
  fireEvent.click(screen.getByRole("button", { name: "Defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
}

// #249: "Defaults" used to fill in read 5s / write 10s / dial 10s / response header 30s, which
// cut off uploads, downloads and slow responses. Caddy's own defaults are empty fields.
describe("timeout Defaults mean Caddy's defaults (#249)", () => {
  const filled: ServerTimeoutValues = {
    readTimeout: "5s", readHeaderTimeout: "2s", writeTimeout: "10s", idleTimeout: "5m", maxHeaderBytes: "1048576", disableHttp3: true,
  };

  it("server timeouts: Defaults clears every field and shows Caddy's values as placeholders", () => {
    const onChange = vi.fn();
    render(<ServerTimeoutsSection value={filled} onChange={onChange} isExpanded />);
    applyDefaults();
    expect(onChange).toHaveBeenCalledWith({
      readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false,
    });
    expect(screen.getByLabelText("Read body timeout").getAttribute("placeholder")).toBe("none");
    expect(screen.getByLabelText("Read header timeout").getAttribute("placeholder")).toBe("Default: 1m");
    expect(screen.getByLabelText("Write timeout").getAttribute("placeholder")).toBe("none");
    expect(screen.getByLabelText("Idle timeout").getAttribute("placeholder")).toBe("Default: 5m");
    // #260: a size field; Caddy's 16384 bytes read as 16 KB whichever unit is selected.
    expect(screen.getByLabelText("Max header size").getAttribute("placeholder")).toBe("Default: 16 KB");
  });

  it("upstream timeouts: Defaults clears both fields and shows Caddy's values as placeholders", () => {
    const onChange = vi.fn();
    render(<TransportSection value={{ dialTimeout: "10s", responseHeaderTimeout: "30s" }} onChange={onChange} isExpanded />);
    applyDefaults();
    expect(onChange).toHaveBeenCalledWith({ dialTimeout: "", responseHeaderTimeout: "" });
    expect(screen.getByLabelText("Connect timeout").getAttribute("placeholder")).toBe("Default: 3s");
    expect(screen.getByLabelText("Response header timeout").getAttribute("placeholder")).toBe("none");
  });
});
