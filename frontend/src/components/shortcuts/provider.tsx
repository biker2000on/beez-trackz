"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Command, Keyboard, Search } from "lucide-react";

import { NAV_ITEMS } from "@/components/shell/nav-items";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ShortcutEntry {
  key: string;
  description: string;
  handler: () => void;
}

interface ShortcutsContextValue {
  register: (entry: ShortcutEntry) => () => void;
  openCommands: () => void;
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
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");
  const [activeCommand, setActiveCommand] = React.useState(0);
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
  const openCommands = React.useCallback(() => {
    setActiveCommand(0);
    setCommandQuery("");
    setCommandOpen(true);
  }, []);
  const shortcutsContext = React.useMemo(
    () => ({ register, openCommands }),
    [register, openCommands],
  );

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        clearGoto();
        setCommandOpen((open) => !open);
        return;
      }
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
  const commands = [
    ...NAV_ITEMS.map((item) => ({
      id: `nav:${item.href}`,
      label: `Go to ${item.label}`,
      hint: `g ${item.shortcutKey}`,
      run: () => router.push(item.href),
    })),
    ...pageShortcuts.map((entry) => ({
      id: `page:${entry.key}`,
      label: entry.description,
      hint: entry.key,
      run: entry.handler,
    })),
  ];
  const normalizedQuery = commandQuery.trim().toLowerCase();
  const filteredCommands = normalizedQuery
    ? commands.filter((command) =>
        command.label.toLowerCase().includes(normalizedQuery),
      )
    : commands;

  function runCommand(command: (typeof commands)[number]) {
    setCommandOpen(false);
    setCommandQuery("");
    command.run();
  }

  return (
    <ShortcutsContext.Provider value={shortcutsContext}>
      {children}
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="size-5 text-primary" />
              Keyboard shortcuts
            </DialogTitle>
            <DialogDescription>
              Press <Kbd>g</Kbd> then a letter to jump between pages, or{" "}
              <Kbd>Ctrl/⌘ K</Kbd> for the command palette.
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
                  <span>Open command palette</span>
                  <Kbd>Ctrl/⌘ K</Kbd>
                </li>
                <li className="flex items-center justify-between text-sm">
                  <span>Show this help</span>
                  <Kbd>?</Kbd>
                </li>
              </ul>
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={commandOpen}
        onOpenChange={(open) => {
          setCommandOpen(open);
          setActiveCommand(0);
          if (!open) setCommandQuery("");
        }}
      >
        <DialogContent className="top-[18%] max-w-lg translate-y-0 gap-2 p-3">
          <DialogHeader className="sr-only">
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>
              Search navigation and actions available on this page.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 border-b px-1 pb-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={commandQuery}
              onChange={(event) => {
                setCommandQuery(event.target.value);
                setActiveCommand(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveCommand((current) =>
                    Math.min(current + 1, filteredCommands.length - 1),
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveCommand((current) => Math.max(current - 1, 0));
                } else if (
                  event.key === "Enter" &&
                  filteredCommands[activeCommand]
                ) {
                  event.preventDefault();
                  runCommand(filteredCommands[activeCommand]);
                }
              }}
              placeholder="Type a page or action…"
              aria-label="Search commands"
              className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {filteredCommands.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No matching commands
              </p>
            ) : (
              <ul className="grid gap-1">
                {filteredCommands.map((command, index) => (
                  <li key={command.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={`h-11 w-full justify-start px-3 ${
                        index === activeCommand ? "bg-secondary" : ""
                      }`}
                      onMouseEnter={() => setActiveCommand(index)}
                      onClick={() => runCommand(command)}
                    >
                      <Command className="size-4 text-muted-foreground" />
                      <span className="flex-1 text-left">{command.label}</span>
                      <Kbd>{command.hint}</Kbd>
                      <ArrowRight className="size-3 text-muted-foreground" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
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

export function CommandPaletteButton() {
  const context = React.useContext(ShortcutsContext);
  if (!context) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      className="w-full justify-start text-muted-foreground"
      onClick={context.openCommands}
    >
      <Search />
      Quick actions
      <span className="ml-auto">
        <Kbd>Ctrl/⌘ K</Kbd>
      </span>
    </Button>
  );
}
