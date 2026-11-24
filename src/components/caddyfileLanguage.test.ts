import { describe, it, expect } from "vitest";
import { StringStream } from "@codemirror/language";
import { caddyfileStreamParser, type CaddyfileState } from "./caddyfileLanguage";

/** Runs the tokenizer over `text`; returns [token text, type] pairs, whitespace left out. */
function tokenize(text: string): [string, string | null][] {
  const p = caddyfileStreamParser;
  const state = p.startState!(4) as CaddyfileState;
  const out: [string, string | null][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() && state.heredoc === null && !state.backtick) {
      p.blankLine?.(state, 4);
      continue;
    }
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const type = p.token(stream, state);
      const tok = stream.current();
      if (tok.trim()) out.push([tok.trim(), type]);
      stream.start = stream.pos;
    }
  }
  return out;
}

const typeOf = (tokens: [string, string | null][], text: string) => tokens.find(([t]) => t === text)?.[1];

const SAMPLE = `{
	email admin@example.com # global options
}

(common) {
	encode gzip
}

example.com, www.example.com {
	import common
	@api path /api/*
	reverse_proxy @api localhost:8080
	root * /srv/www
	header X-Host {http.request.host}
	respond "not # a comment" 200
	respond \`a {brace} in backticks\`
	respond <<HTML
		<p>{ not a block</p>
		HTML
	file_server
}
import /etc/caddy/conf.d/*
`;

describe("caddyfile tokenizer (#283)", () => {
  const tokens = tokenize(SAMPLE);

  it("marks site addresses and snippet definitions", () => {
    expect(typeOf(tokens, "example.com,")).toBe("address");
    expect(typeOf(tokens, "www.example.com")).toBe("address");
    expect(typeOf(tokens, "(common)")).toBe("snippet");
  });

  it("marks directives as the first token on a line inside a block", () => {
    expect(typeOf(tokens, "email")).toBe("directive");
    expect(typeOf(tokens, "reverse_proxy")).toBe("directive");
    expect(typeOf(tokens, "file_server")).toBe("directive");
    expect(typeOf(tokens, "encode")).toBe("directive");
    expect(typeOf(tokens, "gzip")).toBe(null);
  });

  it("marks named matchers, * and path matchers", () => {
    expect(tokens.filter(([t]) => t === "@api").map(([, ty]) => ty)).toEqual(["matcher", "matcher"]);
    expect(typeOf(tokens, "*")).toBe("path");
    expect(typeOf(tokens, "/api/*")).toBe("path");
  });

  it("marks placeholders", () => {
    expect(typeOf(tokens, "{http.request.host}")).toBe("placeholder");
    expect(tokenize("x {\n\tdir {env.TOKEN}\n}")).toContainEqual(["{env.TOKEN}", "placeholder"]);
  });

  it("keeps a # inside a quoted string out of comments", () => {
    expect(typeOf(tokens, '"not # a comment"')).toBe("string");
    expect(typeOf(tokens, "# global options")).toBe("comment");
  });

  it("marks backtick strings, also across lines", () => {
    expect(typeOf(tokens, "`a {brace} in backticks`")).toBe("string");
    const multi = tokenize("x {\n\trespond `one\ntwo` 200\n\tfile_server\n}");
    expect(multi).toContainEqual(["`one", "string"]);
    expect(multi).toContainEqual(["two`", "string"]);
    expect(typeOf(multi, "file_server")).toBe("directive");
  });

  it("treats a heredoc as a string, even with a { inside, and resumes after the marker", () => {
    expect(typeOf(tokens, "<<HTML")).toBe("string");
    expect(typeOf(tokens, "<p>{ not a block</p>")).toBe("string");
    expect(tokens.filter(([t]) => t === "HTML")[0]?.[1]).toBe("string");
    // The { in the heredoc didn't open a block: the next top-level line is still top level.
    expect(typeOf(tokens, "import")).toBe("directive");
    expect(typeOf(tokens, "/etc/caddy/conf.d/*")).toBe(null);
  });

  it("marks braces", () => {
    expect(tokens.filter(([, ty]) => ty === "brace").length).toBe(6);
  });
});
