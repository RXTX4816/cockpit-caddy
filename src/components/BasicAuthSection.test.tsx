import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { mockSpawn } from "../test/setup";
import { mockProcess } from "../test/helpers";
import {
  BasicAuthSection, basicAuthHashMismatch, basicAuthOptionsFromValues, basicAuthOptionsToValues, resolveBasicAuth,
} from "./BasicAuthSection";

const bcryptHash = "$2a$14$HfqUPi8ecmhKr2br56YonenjapN.9FYZm5cv78bUrYuhZWGotTGWC";
const argonHash = "$argon2id$v=19$m=47104,t=1,p=1$c2FsdA$aGFzaA";

describe("basic_auth hash algorithm (#337)", () => {
  afterEach(() => mockSpawn.mockReset());

  it("flags a kept bcrypt hash once argon2id is chosen, and not a re-entered password", () => {
    const kept = [{ username: "a", password: "", existingHash: bcryptHash }];
    expect(basicAuthHashMismatch(kept, "argon2id")).toBe(true);
    expect(basicAuthHashMismatch(kept, "")).toBe(false);
    expect(basicAuthHashMismatch(kept, "bcrypt")).toBe(false);
    expect(basicAuthHashMismatch([{ username: "a", password: "new", existingHash: bcryptHash }], "argon2id")).toBe(false);
    expect(basicAuthHashMismatch([{ username: "a", password: "", existingHash: argonHash }], "")).toBe(true);
  });

  it("hashes new passwords with the chosen algorithm and keeps the others", async () => {
    mockSpawn.mockReturnValue(mockProcess(`${argonHash}\n`));
    const out = await resolveBasicAuth([{ username: "a", password: "pw" }, { username: "b", password: "", existingHash: argonHash }], "argon2id");
    expect(out).toEqual([{ username: "a", passwordHash: argonHash }, { username: "b", passwordHash: argonHash }]);
    expect(mockSpawn.mock.calls[0][0]).toEqual(["caddy", "hash-password", "--algorithm", "argon2id"]);
  });

  it("maps the options to the form and back, and writes none for the defaults", () => {
    expect(basicAuthOptionsFromValues(basicAuthOptionsToValues({ realm: "Area", algorithm: "argon2id" }))).toEqual({ realm: "Area", algorithm: "argon2id" });
    expect(basicAuthOptionsFromValues(basicAuthOptionsToValues(undefined))).toBeUndefined();
  });

  it("shows the realm and algorithm and reports a change", () => {
    const onOptionsChange = vi.fn();
    render(<BasicAuthSection value={[{ username: "a", password: "", existingHash: bcryptHash }]} onChange={() => {}}
      options={{ realm: "", algorithm: "argon2id" }} onOptionsChange={onOptionsChange} isExpanded />);
    expect(screen.getByText(/still have a hash made with the other algorithm/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Realm"), { target: { value: "Area" } });
    expect(onOptionsChange).toHaveBeenCalledWith({ realm: "Area", algorithm: "argon2id" });
  });
});
