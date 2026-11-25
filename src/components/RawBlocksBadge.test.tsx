import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RawBlocksBadge, hasRawBlocks } from "./RawBlocksBadge";

describe("RawBlocksBadge (#348)", () => {
  const nested = "example.com {\n\troute {\n\t\trespond ok\n\t}\n}";

  it("shows for a site with a route and not for a flat one or without the text", () => {
    const { rerender } = render(<RawBlocksBadge proxy={{ siteText: nested }} />);
    expect(screen.getByTestId("raw-blocks-badge").textContent).toBe("Raw blocks");
    rerender(<RawBlocksBadge proxy={{ siteText: "example.com {\n\trespond ok\n}" }} />);
    expect(screen.queryByTestId("raw-blocks-badge")).toBeNull();
    rerender(<RawBlocksBadge proxy={{}} />);
    expect(screen.queryByTestId("raw-blocks-badge")).toBeNull();
    expect(hasRawBlocks({ siteText: nested })).toBe(true);
  });
});
