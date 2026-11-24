import { useEffect, useState } from "react";

/** PatternFly's md breakpoint (#258): below it the main screen uses its phone layout. */
const NARROW_QUERY = "(max-width: 767.98px)";

function matches(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

/** True while the viewport is narrower than PatternFly's md breakpoint (768 px). */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
