import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";

// The Routing tab renders all three header sections at once (#374).
describe("header sections on one tab", () => {
  it("give every element a unique id", () => {
    const { container } = render(
      <>
        <RequestHeadersSection value={undefined} onChange={() => {}} isExpanded />
        <RequestHeadersSection value={undefined} onChange={() => {}} isExpanded variant="down" />
        <ResponseHeadersSection value={undefined} onChange={() => {}} isExpanded />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]"), el => el.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });
});
