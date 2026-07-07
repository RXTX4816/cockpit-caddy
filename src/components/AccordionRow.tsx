import type { ReactNode } from "react";

/** A single row inside the grouped optional-settings box (#146) — adds a divider so
 *  adjacent sections read as a clean list instead of touching directly. Pass `last` for the
 *  final row so its divider doesn't double up against the box's own bottom border. */
export function AccordionRow({ children, last }: { children: ReactNode; last?: boolean }) {
  return (
    <div style={last ? { padding: "0.15rem 0" } : { borderBottom: "1px solid var(--pf-t--global--border--color--default)", padding: "0.15rem 0" }}>
      {children}
    </div>
  );
}
