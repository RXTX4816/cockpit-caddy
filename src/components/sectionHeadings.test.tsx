import type { ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "i18next";
import { FlatSectionsContext } from "./sectionLayout";
import { BasicAuthSection } from "./BasicAuthSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { ForwardAuthSection } from "./ForwardAuthSection";
import { AccessLogSection, accessLogConfigToValues } from "./AccessLogSection";

const flat = (ui: ReactNode) => render(<FlatSectionsContext.Provider value>{ui}</FlatSectionsContext.Provider>);

// #291: inside a tab, sections show a heading of their own instead of the accordion title with
// its bracketed "(optional)" cut off by a regex.
describe("section headings in tab mode (#291)", () => {
  it("uses the heading, not the accordion title", () => {
    flat(<BasicAuthSection value={[]} onChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "HTTP Basic Auth" })).toBeInTheDocument();
  });

  it("keeps the error handler count", () => {
    const handlers = [1, 2, 3].map(() => ({ matchType: "all" as const, type: "respond" as const, body: "x" }));
    flat(<ErrorHandlersSection value={handlers} onChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "Custom error handlers (3)" })).toBeInTheDocument();
  });

  it("doesn't depend on how a translation punctuates the accordion title", async () => {
    i18n.addResource("en", "translation", "forward_auth.section_title", "Optional: forward authentication");
    try {
      flat(<ForwardAuthSection value={undefined} onChange={() => {}} />);
      expect(screen.getByRole("heading", { name: "Forward Authentication" })).toBeInTheDocument();
    } finally {
      i18n.addResource("en", "translation", "forward_auth.section_title", "Forward Authentication (optional)");
    }
  });

  it("keeps \"Access logging\" on a site's access log", () => {
    flat(<AccessLogSection value={accessLogConfigToValues(undefined)} onChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "Access logging" })).toBeInTheDocument();
  });

  it("leaves the heading out of the global runtime log, which is not an access log", () => {
    flat(<AccessLogSection idPrefix="rl" heading={null} enableLabel="Override Caddy's default runtime log destination" value={accessLogConfigToValues(undefined)} onChange={() => {}} />);
    expect(screen.queryByRole("heading", { name: "Access logging" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Override Caddy's default runtime log destination")).toBeInTheDocument();
  });
});
