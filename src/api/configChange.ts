import { getHost, type Host } from "@rxtx4816/cockpit-plugin-base-react/host";

/** The new content of one file. */
export interface FileChange {
  path: string;
  content: string;
}

export interface ConfigChangeSteps {
  /** Runs before anything is written, on the files that actually change. Throw to refuse the whole change. */
  check?: (changed: FileChange[]) => Promise<void>;
  /** Runs once every changed file is in place. Throw to have every file put back. */
  validate: () => Promise<void>;
  /** Runs after validation passed, on the files that changed. A failure here leaves the change in place. */
  afterCommit?: (changed: FileChange[]) => Promise<void>;
}

/** Putting the files back after a failed change did not work: the config on disk is in an unknown state. */
export class ConfigRestoreError extends Error {
  readonly cause: unknown;
  readonly paths: string[];
  constructor(cause: unknown, paths: string[]) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`${why} (and putting back ${paths.join(", ")} failed; check them by hand)`);
    this.name = "ConfigRestoreError";
    this.cause = cause;
    this.paths = paths;
  }
}

const ESCALATE = { superuser: "try" } as const;

/**
 * Changes several files as one: all of them take their new content, the config is validated
 * once, and if anything fails every file goes back to exactly what it held (a file that did not
 * exist is removed again). Files whose content is already as asked are left alone; when nothing
 * changes, nothing is validated.
 *
 * Callers say what the files should contain and never write, validate or roll back themselves.
 */
export async function applyConfigChange(
  changes: FileChange[],
  steps: ConfigChangeSteps,
  host: Host = getHost(),
): Promise<void> {
  const originals = new Map<string, string | null>();
  for (const { path } of changes) {
    if (!originals.has(path)) originals.set(path, await host.readFile(path, ESCALATE).catch(() => null));
  }
  const changed = changes.filter(c => (originals.get(c.path) ?? null) !== c.content);
  if (changed.length === 0) return;

  await steps.check?.(changed);

  const written: string[] = [];
  try {
    for (const c of changed) {
      await host.writeFile(c.path, c.content, ESCALATE);
      written.push(c.path);
    }
    await steps.validate();
  } catch (e) {
    const failed: string[] = [];
    // The file being written when it failed may be half-written, so it is restored too.
    const touched = changed.map(c => c.path).filter(p => written.includes(p) || p === changed[written.length]?.path);
    for (const path of touched.reverse()) {
      const original = originals.get(path) ?? null;
      try {
        if (original === null) await host.run(["rm", "-f", "--", path], ESCALATE);
        else await host.writeFile(path, original, ESCALATE);
      } catch {
        failed.push(path);
      }
    }
    if (failed.length) throw new ConfigRestoreError(e, failed);
    throw e;
  }
  await steps.afterCommit?.(changed);
}
