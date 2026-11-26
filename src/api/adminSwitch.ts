/**
 * Moving Caddy's admin endpoint without locking the plugin out of it (#330).
 *
 * The plugin talks to Caddy over the admin API, so a reload that moves the endpoint is the one
 * reload that can cut the plugin off. `systemctl reload` can't do it either: `caddy reload` sends
 * the new config to the address the new config names, where nothing listens yet. So the new
 * Caddyfile goes over the old address, the new address is probed, and only an answer there
 * switches the plugin over. Without one, the Caddyfile from before the save comes back.
 */

/** Where the plugin reaches the admin API: the same shape as its own address setting. */
export interface AdminTarget {
  transport: "tcp" | "unix";
  /** `http://host:port`, as in the plugin's address setting. */
  tcp: string;
  /** The Unix socket path. */
  socket: string;
}

/**
 * The address the plugin reaches Caddy at once the Caddyfile's `admin` address is live. An
 * unset address is Caddy's default, localhost:2019. A TCP target leaves the socket setting as
 * it is and the other way round, so switching back keeps what the user had.
 */
export function adminTarget(admin: string | undefined, current: { tcp: string; socket: string }): AdminTarget {
  const a = (admin ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (a.startsWith("unix/")) return { transport: "unix", tcp: current.tcp, socket: a.slice("unix/".length).replace(/\|[0-7]+$/, "") };
  const hostPort = a.replace(/^tcp\//, "") || "localhost:2019";
  const colon = hostPort.lastIndexOf(":");
  const rawHost = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon >= 0 ? hostPort.slice(colon + 1) : "2019";
  // Caddy listens on IPv4 for localhost and for no host; curl's localhost may try ::1 first.
  const host = !rawHost || rawHost === "localhost" ? "127.0.0.1" : rawHost;
  return { transport: "tcp", tcp: `http://${host}:${port}`, socket: current.socket };
}

/** The Caddyfile's admin address changed in a way that moves the endpoint. */
export function adminMoves(before: string | undefined, after: string | undefined, current: { tcp: string; socket: string }): boolean {
  const a = adminTarget(before, current);
  const b = adminTarget(after, current);
  return a.transport !== b.transport || (a.transport === "tcp" ? a.tcp !== b.tcp : a.socket !== b.socket);
}

export class AdminSwitchError extends Error {
  /** `rejection`: Caddy's message when it refused the config; unset when the target never answered. */
  constructor(readonly rejection: string | undefined, readonly restored: boolean, readonly target?: AdminTarget) {
    super(rejection ?? "the new admin address did not answer");
    this.name = "AdminSwitchError";
  }
}

export interface AdminSwitchSteps {
  /** Loads the saved Caddyfile over the old address (or restarts Caddy). Throws `rejected` when Caddy refused it. */
  apply: () => Promise<void>;
  /** True when the admin API answers at the target. */
  probe: (target: AdminTarget) => Promise<boolean>;
  /** Points the plugin at the target. */
  switchTo: (target: AdminTarget) => void;
  /** Writes the Caddyfile from before the save back and makes Caddy load it again. */
  restore: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** A rejection from Caddy, as opposed to a connection that dropped while the endpoint moved. */
export class AdminRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminRejectedError";
  }
}

/**
 * Applies the saved Caddyfile, then probes the target once a second for `tries` seconds. An
 * answer switches the plugin over; no answer, or a rejected config, restores the old Caddyfile
 * and throws AdminSwitchError.
 */
export async function switchAdminEndpoint(target: AdminTarget, steps: AdminSwitchSteps, tries = 10, intervalMs = 1000): Promise<void> {
  const sleep = steps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  let reason: string | undefined;
  try {
    await steps.apply();
  } catch (e) {
    // The old endpoint closes once the new config is in, which can cut the answer short.
    // Only a rejection means the config didn't take; anything else is up to the probe.
    if (e instanceof AdminRejectedError) reason = e.message;
  }
  if (reason === undefined) {
    for (let i = 0; i < tries; i++) {
      if (await steps.probe(target)) {
        steps.switchTo(target);
        return;
      }
      if (i < tries - 1) await sleep(intervalMs);
    }
  }
  let restored = true;
  try {
    await steps.restore();
  } catch {
    restored = false;
  }
  throw new AdminSwitchError(reason, restored, target);
}
