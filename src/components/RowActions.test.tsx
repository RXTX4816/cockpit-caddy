import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RowActions } from "./RowActions";

// #259: Edit stays visible; Duplicate and Delete live in a kebab.
describe("RowActions", () => {
  it("edits from the icon button and reaches duplicate/delete through the kebab", () => {
    const onEdit = vi.fn(), onDuplicate = vi.fn(), onDelete = vi.fn();
    render(<RowActions onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} />);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(onDuplicate).toHaveBeenCalled();
  });
});
