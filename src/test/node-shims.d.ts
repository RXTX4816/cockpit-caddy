// The few Node APIs caddyAdapt.test.ts uses to run a real `caddy adapt`. The plugin
// itself runs in the browser, so the project doesn't pull in @types/node for these.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8"; stdio?: unknown },
  ): string;
  export function execFileSync(file: string, args: string[], options?: { stdio?: unknown }): unknown;
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare const process: { env: Record<string, string | undefined> };
