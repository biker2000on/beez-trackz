"use client";

/**
 * Infinite-scroll trigger, the Folio ledger's pattern: an element at the end
 * of the list is watched with an IntersectionObserver and `onReach` fires
 * when it comes within `rootMargin` of the viewport. Returns a callback ref
 * for that element.
 *
 * `enabled` should be false while a page is loading or when there is
 * nothing more to load, so one scroll asks for one page.
 */

import * as React from "react";

export function useInfiniteSentinel(
  onReach: () => void,
  { enabled, rootMargin = "400px 0px" }: { enabled: boolean; rootMargin?: string },
) {
  const [node, setNode] = React.useState<Element | null>(null);
  const onReachRef = React.useRef(onReach);
  React.useLayoutEffect(() => {
    onReachRef.current = onReach;
  });

  React.useEffect(() => {
    if (!node || !enabled || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachRef.current();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, enabled, rootMargin]);

  return setNode;
}
