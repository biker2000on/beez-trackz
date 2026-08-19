"use client";

import * as React from "react";

/**
 * Marker stored on the history entry a dialog pushes for itself. Radix pushes
 * nothing, so on Android the hardware Back button leaves the route instead of
 * closing the dialog that is covering it.
 */
const DIALOG_HISTORY_KEY = "beezDialog";

type OpenDialog = {
  /** False once the browser has popped this dialog's entry for us. */
  pushed: { current: boolean };
  close: () => void;
};

/** Innermost open dialog last, so Back closes one layer at a time. */
const openDialogs: OpenDialog[] = [];

function isDialogEntry(): boolean {
  const state = window.history.state as Record<string, unknown> | null;
  return state !== null && state[DIALOG_HISTORY_KEY] === true;
}

function handlePopState() {
  const top = openDialogs.pop();
  if (!top) return;
  top.pushed.current = false;
  top.close();
}

/**
 * Gives an open dialog its own history entry so Back closes the dialog and
 * stays on the page.
 *
 * The pushed state spreads the current state so the Next.js router keeps its
 * internals (without them a `popstate` triggers a full reload). When the dialog
 * closes by any other route — the X, Escape, Cancel, a successful submit — the
 * entry is popped again, but only while it is still the current one, so a
 * navigation performed from inside the dialog is never undone.
 */
export function useDialogHistory(
  open: boolean,
  onOpenChange?: (open: boolean) => void,
) {
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  React.useEffect(() => {
    if (!open || typeof window === "undefined") return;

    const pushed = { current: true };
    const entry: OpenDialog = {
      pushed,
      close: () => onOpenChangeRef.current?.(false),
    };
    window.history.pushState(
      { ...window.history.state, [DIALOG_HISTORY_KEY]: true },
      "",
    );
    if (openDialogs.length === 0) {
      window.addEventListener("popstate", handlePopState);
    }
    openDialogs.push(entry);

    return () => {
      const index = openDialogs.indexOf(entry);
      if (index !== -1) openDialogs.splice(index, 1);
      if (openDialogs.length === 0) {
        window.removeEventListener("popstate", handlePopState);
      }
      // Closed by the X, Escape, or a submit: take our entry back out so the
      // next Back reaches the previous page rather than a stale entry.
      if (pushed.current && isDialogEntry()) window.history.back();
    };
  }, [open]);
}
