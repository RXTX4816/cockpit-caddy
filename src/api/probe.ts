export type ProbeStatus = "pending" | "up" | "down" | "error";

export interface ProbeTarget {
  scheme: "http" | "https";
  host: string;
  port: number;
}

/**
 * Probe a single upstream from the host using curl.
 * Any HTTP response (even 4xx/5xx) means the process is up.
 * Connection refused or timeout means it's down.
 */
export async function probeUpstream({ scheme, host, port }: ProbeTarget): Promise<"up" | "down" | "error"> {
  const url = `${scheme}://${host}:${port}/`;
  try {
    await cockpit.spawn(
      ["curl", "-s", "-o", "/dev/null", "--connect-timeout", "5", "--max-time", "10", "-k", url],
      { err: "ignore" },
    );
    return "up";
  } catch (e) {
    const err = e as { problem?: string };
    if (err.problem === "not-found" || err.problem === "access-denied") return "error";
    return "down";
  }
}
