import { useState, useEffect } from "react";

export function useCaddyVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cockpit.spawn(["caddy", "version"], { err: "ignore" })
      .then((out: string) => {
        if (!cancelled) setVersion(out.trim().split(/\s+/)[0] ?? null);
      })
      .catch(() => { /* caddy not installed — stay null */ });
    return () => { cancelled = true; };
  }, []);

  return version;
}
