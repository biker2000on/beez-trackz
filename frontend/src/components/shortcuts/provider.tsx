"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Keyboard } from "lucide-react";

import { NAV_ITEMS } from "@/components/shell/nav-items";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ShortcutEntry {
  key: string;
  description: string;
  handler: () => void;
}

interface ShortcutsContextValue {
  register: (entry: ShortcutEntry) => () => void;
}

const ShortcutsContext = React.createContext<ShortcutsContextValue | null>(
  null,
);

/** True when the event originates from a place where typing is expected. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** True when a Radix dialog/sheet/alert-dialog is currently open. */
function isDialogOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  );
}

const GOTO_TIMEOUT_MS = 1500;

export function ShortcutsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [entries, setEntries] = React.useState<Map<string, ShortcutEntry>>(
    () => new Map(),
  );
  const entriesRef = React.useRef(entries);
  React.useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  const gotoPendingRef = React.useRef(false);
  const gotoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const register = React.useCallback((entry: ShortcutEntry) => {
    const key = entry.key.toLowerCase();
    setEntries((prev) => {
      const next = new Map(prev);
      next.set(key, entry);
      return next;
    });
    return () => {
      setEntries((prev) => {
        if (prev.get(key) !== entry) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    };
  }, []);

  React.useEffect(() => {
    function clearGoto() {
      gotoPendingRef.current = false;
      if (gotoTimerRef.current) {
        clearTimeout(gotoTimerRef.current);
        gotoTimerRef.current = null;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (isDialogOpen()) return;

      const key = event.key;

      if (key === "?") {
        event.preventDefault();
        clearGoto();
        setHelpOpen(true);
        return;
      }

      if (gotoPendingRef.current) {
        clearGoto();
        const item = NAV_ITEMS.find(
          (nav) => nav.shortcutKey === key.toLowerCase(),
        );
        if (item) {
          event.preventDefault();
          router.push(item.href);
        }
        return;
      }

      if (key === "g" || key === "G") {
        event.preventDefault();
        gotoPendingRef.current = true;
        gotoTimerRef.current = setTimeout(clearGoto, GOTO_TIMEOUT_MS);
        return;
      }

      const entry = entriesRef.current.get(key.toLowerCase());
      if (entry) {
        event.preventDefault();
        entry.handler();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearGoto();
    };
  }, [router]);

  const pageShortcuts = Array.from(entries.values());

  return (
    <ShortcutsContext.Provider value={{ register }}>
      {children}
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="size-5 text-primary" />
              Keyboard shortcuts
            </DialogTitle>
            <DialogDescription>
              Press <Kbd>g</Kbd> then a letter to jump between pages.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Navigation
              </h3>
              <ul className="grid gap-1.5">
                {NAV_ITEMS.map((item) => (
                  <li
                    key={item.href}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>{item.label}</span>
                    <span className="flex items-center gap-1">
                      <Kbd>g</Kbd>
                      <Kbd>{item.shortcutKey}</Kbd>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            {pageShortcuts.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  This page
                </h3>
                <ul className="grid gap-1.5">
                  {pageShortcuts.map((entry) => (
                    <li
                      key={entry.key}
                      className="flex items-center justify-between text-sm"
                    >
                      <span>{entry.description}</span>
                      <Kbd>{entry.key}</Kbd>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                General
              </h3>
              <ul className="grid gap-1.5">
                <li className="flex items-center justify-between text-sm">
                  <span>Show this help</span>
                  <Kbd>?</Kbd>
                </li>
              </ul>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </ShortcutsContext.Provider>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * Register a page-level keyboard shortcut. The shortcut is listed in the `?`
 * help dialog and automatically removed when the component unmounts.
 */
export function useShortcut(
  key: string,
  description: string,
  handler: () => void,
) {
  const context = React.useContext(ShortcutsContext);
  if (!context) {
    throw new Error("useShortcut must be used within a ShortcutsProvider");
  }
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    return context.register({
      key,
      description,
      handler: () => handlerRef.current(),
    });
  }, [context, key, description]);
}
