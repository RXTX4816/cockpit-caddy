import { describe, it, expect, afterEach } from "vitest";
import { hashPassword } from "./caddy";
import { mockSpawn } from "../test/setup";
import { mockProcess } from "../test/helpers";

// #255: `--plaintext <pw>` puts the password in argv, which any local user can read from
// /proc/<pid>/cmdline while caddy runs. Caddy reads it from stdin instead (checked with v2.11.7:
// one line, newline-terminated, when stdin is not a terminal).
describe("hashPassword", () => {
  afterEach(() => mockSpawn.mockReset());

  it("passes the password on stdin, never in argv", async () => {
    const proc = mockProcess("$2a$14$hash\n");
    mockSpawn.mockReturnValue(proc);
    expect(await hashPassword("s3cret pw")).toBe("$2a$14$hash");
    const argv = mockSpawn.mock.calls[0][0] as string[];
    expect(argv).toEqual(["caddy", "hash-password"]);
    expect(argv.join(" ")).not.toContain("s3cret");
    expect(proc.input).toHaveBeenCalledWith("s3cret pw\n");
  });

  // #337: argon2id is picked with a flag; bcrypt stays the plain call older Caddy also takes.
  it("asks for argon2id with the flag, and for bcrypt without one", async () => {
    mockSpawn.mockReturnValue(mockProcess("$argon2id$v=19$hash\n"));
    expect(await hashPassword("pw", "argon2id")).toBe("$argon2id$v=19$hash");
    expect(mockSpawn.mock.calls[0][0]).toEqual(["caddy", "hash-password", "--algorithm", "argon2id"]);
    mockSpawn.mockReturnValue(mockProcess("$2a$14$hash\n"));
    await hashPassword("pw", "bcrypt");
    expect(mockSpawn.mock.calls[1][0]).toEqual(["caddy", "hash-password"]);
  });
});
