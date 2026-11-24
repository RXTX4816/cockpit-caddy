import { StreamLanguage, LanguageSupport, foldService, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * Caddyfile syntax highlighting (#283): a small stream tokenizer, no validation.
 * Token names map to highlight tags in `tokenTable`, so both the default light style and
 * the one-dark theme colour them.
 */
export interface CaddyfileState {
  /** `{ }` nesting depth: 0 is the top level (site addresses, snippets, the global block). */
  depth: number;
  /** The closing marker while inside a heredoc (`<<MARKER`). */
  heredoc: string | null;
  /** Inside a backtick string that spans lines. */
  backtick: boolean;
  /** Position of the next token on the current line (0 = the directive / address). */
  tokenIndex: number;
  /** The current top-level line is an `import` line, not a site header. */
  importLine: boolean;
}

export type CaddyfileToken =
  | "comment" | "string" | "placeholder" | "brace" | "address" | "snippet"
  | "directive" | "matcher" | "path";

/** A word token; a `{…}` placeholder inside it (`/api/{path}`) becomes a token of its own. */
const WORD = /^[^\s{}"`]+/;

export const caddyfileStreamParser: StreamParser<CaddyfileState> = {
  name: "caddyfile",

  startState: () => ({ depth: 0, heredoc: null, backtick: false, tokenIndex: 0, importLine: false }),

  copyState: s => ({ ...s }),

  token(stream, state): CaddyfileToken | null {
    if (stream.sol()) {
      state.tokenIndex = 0;
      state.importLine = false;
    }

    if (state.heredoc !== null) {
      if (stream.sol() && stream.string.trim() === state.heredoc) state.heredoc = null;
      stream.skipToEnd();
      return "string";
    }
    if (state.backtick) {
      if (stream.skipTo("`")) {
        stream.next();
        state.backtick = false;
      } else {
        stream.skipToEnd();
      }
      return "string";
    }

    if (stream.eatSpace()) return null;
    const ch = stream.peek();

    // A comment starts a token; a `#` inside a word or a string isn't one.
    if (ch === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (ch === '"') {
      stream.next();
      let c: string | void;
      while ((c = stream.next()) !== undefined) {
        if (c === "\\") stream.next();
        else if (c === '"') break;
      }
      state.tokenIndex++;
      return "string";
    }
    if (ch === "`") {
      stream.next();
      if (stream.skipTo("`")) stream.next();
      else {
        stream.skipToEnd();
        state.backtick = true;
      }
      state.tokenIndex++;
      return "string";
    }
    const heredoc = stream.match(/^<<([A-Za-z0-9_-]+)\s*$/) as RegExpMatchArray | null;
    if (heredoc) {
      state.heredoc = heredoc[1];
      state.tokenIndex++;
      return "string";
    }
    if (stream.match(/^\{[^\s{}]+\}/)) {
      // A placeholder, standing alone (`{http.request.host}`) or inside a word (`/api/{path}`).
      state.tokenIndex++;
      return state.depth === 0 && !state.importLine ? "address" : "placeholder";
    }
    if (ch === "{") {
      stream.next();
      state.depth++;
      return "brace";
    }
    if (ch === "}") {
      stream.next();
      state.depth = Math.max(0, state.depth - 1);
      return "brace";
    }

    if (!stream.match(WORD)) {
      stream.next();
      return null;
    }
    const word = stream.current();
    const index = state.tokenIndex++;

    if (state.depth === 0) {
      if (index === 0 && word === "import") {
        state.importLine = true;
        return "directive";
      }
      if (state.importLine) return null;
      if (/^&?\(.+\)$/.test(word)) return "snippet";
      return "address";
    }
    if (word.startsWith("@")) return "matcher";
    if (index === 0) return "directive";
    if (word === "*" || word.startsWith("/")) return "path";
    return null;
  },

  blankLine(state) {
    state.tokenIndex = 0;
    state.importLine = false;
  },

  languageData: { commentTokens: { line: "#" } },

  tokenTable: {
    comment: tags.comment,
    string: tags.string,
    placeholder: tags.special(tags.variableName),
    brace: tags.brace,
    address: tags.heading,
    snippet: tags.definition(tags.variableName),
    directive: tags.keyword,
    matcher: tags.labelName,
    path: tags.url,
  },
};

export const caddyfileLanguage = StreamLanguage.define(caddyfileStreamParser);

/** Folds a `{ … }` block from the line that opens it to its closing brace. */
const caddyfileFolding = foldService.of((state, lineStart, lineEnd) => {
  const line = state.doc.sliceString(lineStart, lineEnd);
  if (!/\{\s*$/.test(line.replace(/\s#.*$/, ""))) return null;
  let depth = 0;
  for (let n = state.doc.lineAt(lineStart).number; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text.replace(/(^|\s)#.*$/, "");
    for (const c of text) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth <= 0) {
      if (n === state.doc.lineAt(lineStart).number) return null;
      const end = state.doc.line(n);
      const close = end.from + end.text.lastIndexOf("}");
      return close > lineEnd ? { from: lineEnd, to: close } : null;
    }
  }
  return null;
});

/** The Caddyfile language with highlighting and `{ }` folding, for every CodeMirror view. */
export function caddyfile(): LanguageSupport {
  return new LanguageSupport(caddyfileLanguage, [caddyfileFolding]);
}
