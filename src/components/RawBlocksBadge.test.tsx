import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RawBlocksBadge, hasRawBlocks, rawBlocksOf } from "./RawBlocksBadge";

describe("RawBlocksBadge (#348)", () => {
  // The tree edits a route of plain directives; a block of options it only shows as written.
  const nested = "example.com {\n\troute {\n\t\treverse_proxy localhost:1 {\n\t\t\theader_up X-A 1\n\t\t}\n\t}\n}";
  const editable = "example.com {\n\troute {\n\t\trespond ok\n\t}\n}";

  it("shows for a site with a route and not for a flat one or without the text", () => {
    const { rerender } = render(<RawBlocksBadge proxy={{ siteText: nested }} />);
    expect(screen.getByTestId("raw-blocks-badge").textContent).toBe("Raw blocks");
    rerender(<RawBlocksBadge proxy={{ siteText: editable }} />);
    expect(screen.queryByTestId("raw-blocks-badge")).toBeNull();
    rerender(<RawBlocksBadge proxy={{ siteText: nested }} />);
    rerender(<RawBlocksBadge proxy={{ siteText: "example.com {\n\trespond ok\n}" }} />);
    expect(screen.queryByTestId("raw-blocks-badge")).toBeNull();
    rerender(<RawBlocksBadge proxy={{}} />);
    expect(screen.queryByTestId("raw-blocks-badge")).toBeNull();
    expect(hasRawBlocks({ siteText: nested })).toBe(true);
    expect(rawBlocksOf({ siteText: nested })).toEqual(["reverse_proxy localhost:1 {"]);
    expect(hasRawBlocks({ siteText: editable })).toBe(false);
  });
});
