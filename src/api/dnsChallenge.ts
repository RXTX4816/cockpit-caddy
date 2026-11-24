/**
 * ACME DNS challenge support (#261, #289): which DNS provider modules the Caddy binary has,
 * and the root-only env file that holds their credentials. The Caddyfile only ever gets
 * `{env.NAME}` references; values go to DNS_ENV_PATH, which a systemd drop-in loads into
 * caddy.service. Values are written through stdin and never come back to the UI.
 */

export const DNS_ENV_PATH = "/etc/caddy/dns.env";
export const DNS_DROPIN_DIR = "/etc/systemd/system/caddy.service.d";
export const DNS_DROPIN_PATH = `${DNS_DROPIN_DIR}/cockpit-caddy-dns.conf`;
export const DNS_MODULES_DOCS = "https://caddyserver.com/docs/modules/";

/** Option names to prefill for common providers (checked against each module's README). */
export const DNS_PROVIDER_PRESETS: Record<string, string[]> = {
  cloudflare: ["api_token"],
  hetzner: ["api_token"],
  duckdns: ["api_token"],
  desec: ["token"],
};

/** The provider names from `caddy list-modules` output (`dns.providers.<name>` lines). */
export function parseDnsProviders(listModulesOutput: string): string[] {
  return listModulesOutput.split("\n")
    .map(l => l.trim().match(/^dns\.providers\.([A-Za-z0-9_.-]+)$/)?.[1])
    .filter((n): n is string => !!n)
    .sort();
}

/** The DNS provider modules the installed Caddy has; empty when it has none or can't be asked. */
export async function listDnsProviders(): Promise<string[]> {
  try {
    return parseDnsProviders(await cockpit.spawn(["caddy", "list-modules"], { superuser: "try", err: "ignore" }));
  } catch {
    return [];
  }
}

const envPart = (s: string) => s.toUpperCase().replace(/\*/g, "WILDCARD").replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The env variable for a provider option: `CADDY_DNS_<OPTION>` for the global provider, and
 * `CADDY_DNS_SITE_<SITE>_<OPTION>` per site (#289). The site part keeps a short hash of the
 * exact name, so `a.example.com` and `a-example.com` don't share a variable.
 */
export function dnsEnvVarName(option: string, site?: string): string {
  if (!site) return `CADDY_DNS_${envPart(option)}`;
  let h = 0;
  for (const c of site.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `CADDY_DNS_SITE_${envPart(site)}_${h.toString(36).toUpperCase()}_${envPart(option)}`;
}

/** systemd EnvironmentFile lines, every value double-quoted with `\` and `"` escaped. */
export function formatEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join("\n") + (Object.keys(vars).length ? "\n" : "");
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(["\\])/g, "$1");
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const root = (args: string[]) => cockpit.spawn(args, { superuser: "require", err: "message" });

/** Runs a root command with `data` on stdin (closed after), so it never shows in a command line. */
async function rootWithInput(args: string[], data: string): Promise<void> {
  const proc = root(args);
  proc.input(data);
  await proc;
}

async function readEnvText(): Promise<string | null> {
  try {
    return await root(["cat", "--", DNS_ENV_PATH]);
  } catch {
    return null;
  }
}

async function readEnvFile(): Promise<Record<string, string> | null> {
  const text = await readEnvText();
  return text === null ? null : parseEnvFile(text);
}

async function exists(path: string): Promise<boolean> {
  try {
    await root(["test", "-e", path]);
    return true;
  } catch {
    return false;
  }
}

/** Writes the env file root:root mode 600: umask 077 from the start, then an atomic rename. */
function writeEnvText(text: string): Promise<void> {
  return rootWithInput(
    ["sh", "-c", `umask 077 && cat > ${DNS_ENV_PATH}.tmp && chown root:root ${DNS_ENV_PATH}.tmp && chmod 600 ${DNS_ENV_PATH}.tmp && mv ${DNS_ENV_PATH}.tmp ${DNS_ENV_PATH}`],
    text,
  );
}

function writeDropin(): Promise<void> {
  return rootWithInput(
    ["sh", "-c", `mkdir -p ${DNS_DROPIN_DIR} && cat > ${DNS_DROPIN_PATH}`],
    "# Written by the Cockpit Caddy plugin: credentials for the ACME DNS challenge.\n[Service]\nEnvironmentFile=-" + DNS_ENV_PATH + "\n",
  );
}

/** The names of the variables in the env file (never their values). */
export async function readDnsEnvNames(): Promise<string[]> {
  return Object.keys((await readEnvFile()) ?? {});
}

/**
 * The env vars the running Caddy service would get, for `caddy validate` (#261): a provider
 * that checks its credentials at provisioning would fail validation without them.
 */
export async function dnsEnviron(): Promise<string[]> {
  const vars = await readEnvFile();
  return vars ? Object.entries(vars).map(([k, v]) => `${k}=${v}`) : [];
}

/**
 * Sets and removes credential variables in the env file. Writes it root:root mode 600, adds
 * the systemd drop-in that loads it, and runs `systemctl daemon-reload`. With no variable
 * left, the file and the drop-in go. The new environment only reaches Caddy on a restart;
 * `changed` says one is needed. `restore` puts the file and the drop-in back as they were
 * before this call (#316), for a save that fails afterwards; the old text stays in this
 * module and goes back through stdin.
 */
export async function applyDnsSecrets(
  set: Record<string, string>,
  remove: string[],
): Promise<{ changed: boolean; restore: () => Promise<void> }> {
  for (const [k, v] of Object.entries(set)) {
    if (/[\r\n]/.test(v)) throw new Error(`The value of ${k} has a line break`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid variable name: ${k}`);
  }
  const beforeText = await readEnvText();
  const current = beforeText === null ? {} : parseEnvFile(beforeText);
  const next = { ...current };
  for (const k of remove) delete next[k];
  Object.assign(next, set);
  const changed = formatEnvFile(next) !== formatEnvFile(current);
  if (!changed) return { changed: false, restore: async () => {} };

  const hadDropin = await exists(DNS_DROPIN_PATH);
  if (!Object.keys(next).length) {
    await root(["rm", "-f", DNS_ENV_PATH, DNS_DROPIN_PATH]);
  } else {
    await writeEnvText(formatEnvFile(next));
    await writeDropin();
  }
  await root(["systemctl", "daemon-reload"]);

  const restore = async () => {
    if (beforeText === null) await root(["rm", "-f", DNS_ENV_PATH]);
    else await writeEnvText(beforeText);
    if (hadDropin) await writeDropin();
    else await root(["rm", "-f", DNS_DROPIN_PATH]);
    await root(["systemctl", "daemon-reload"]);
  };
  return { changed: true, restore };
}
