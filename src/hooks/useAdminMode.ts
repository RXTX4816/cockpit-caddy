import { useState, useEffect } from "react";

/**
 * Returns whether the current Cockpit session has administrative (superuser) access.
 * - `null` — still determining (show nothing or a neutral state)
 * - `true`  — admin access granted
 * - `false` — limited mode; privileged operations will fail
 */
export function useAdminMode(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    const perm = cockpit.permission({ admin: true });
    setAllowed(perm.allowed);
    const onChange = () => setAllowed(perm.allowed);
    perm.addEventListener("changed", onChange);
    return () => {
      perm.removeEventListener("changed", onChange);
      perm.close();
    };
  }, []);

  return allowed;
}
