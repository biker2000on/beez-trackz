"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { ShortcutsHelpDialog } from "./shortcuts-help-dialog";

export interface ShortcutDef {
  /** Single key (e.g. "n", "b", "?") or a "g x" sequence (e.g. "g h"). */
  keys: string;
  description: string;
  /** Help-dialog grouping. */
  group: string;
  handler: () => void;
}

interface ShortcutContextValue {
  register: (shortcut: ShortcutDef) => () => void;
  shortcuts: ShortcutDef[];
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

const SEQUENCE_TIMEOUT_MS = 1500;

const NAV_SHORTCUTS: Array<{ keys: string; description: string; href: string }> = [
  { keys: "g d", description: "Go to Dashboard", href: "/dashboard" },
  { keys: "g a", description: "Go to Apiaries", href: "/apiaries" },
  { keys: "g h", description: "Go to Hives", href: "/hives" },
  { keys: "g q", description: "Go to Queens", href: "/genealogy" },
  { keys: "g r", description: "Go to Recommendations", href: "/recommendations" },
  { keys: "g y", description: "Go to Honey", href: "/harvest" },
  { keys: "g i", description: "Go to Inventory", href: "/inventory" },
  { keys: "g s", description: "Go to Settings", href: "/settings" },
];

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

export function ShortcutProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  // Page-registered shortcuts live in a ref (handler identity changes per
  // render); a state copy feeds the help dialog.
  const registryRef = useRef<Map<string, ShortcutDef>>(new Map());
  const [registered, setRegistered] = useState<ShortcutDef[]>([]);
  const pendingPrefix = useRef<{ key: string; at: number } | null>(null);

  const register = useCallback((shortcut: ShortcutDef) => {
    const id = `${shortcut.group}:${shortcut.keys}`;
    registryRef.current.set(id, shortcut);
    setRegistered([...registryRef.current.values()]);
    return () => {
      // Only remove if this exact registration still owns the slot
      if (registryRef.current.get(id) === shortcut) {
        registryRef.current.delete(id);
        setRegistered([...registryRef.current.values()]);
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // Radix dialogs portal to body; while one is open, leave keys alone.
      if (document.querySelector("[role=dialog][data-state=open]")) return;

      const key = event.key;

      // Help overlay
      if (key === "?") {
        event.preventDefault();
        setHelpOpen((prev) => !prev);
        return;
      }

      // Sequence prefix
      const now = Date.now();
      const pending =
        pendingPrefix.current && now - pendingPrefix.current.at < SEQUENCE_TIMEOUT_MS
          ? pendingPrefix.current
          : null;
      pendingPrefix.current = null;

      if (pending) {
        const seq = `${pending.key} ${key.toLowerCase()}`;
        const nav = NAV_SHORTCUTS.find((n) => n.keys === seq);
        if (nav) {
          event.preventDefault();
          router.push(nav.href);
          return;
        }
        const custom = [...registryRef.current.values()].find((s) => s.keys === seq);
        if (custom) {
          event.preventDefault();
          custom.handler();
          return;
        }
        return;
      }

      if (key.toLowerCase() === "g") {
        pendingPrefix.current = { key: "g", at: now };
        return;
      }

      const single = [...registryRef.current.values()].find((s) => s.keys === key);
      if (single) {
        event.preventDefault();
        single.handler();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  const value = useMemo(
    () => ({ register, shortcuts: registered }),
    [register, registered]
  );

  return (
    <ShortcutContext.Provider value={value}>
      {children}
      <ShortcutsHelpDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        navShortcuts={NAV_SHORTCUTS}
        pageShortcuts={registered}
      />
    </ShortcutContext.Provider>
  );
}

export function useShortcutRegistry(): ShortcutContextValue {
  const ctx = useContext(ShortcutContext);
  if (!ctx) throw new Error("useShortcutRegistry requires ShortcutProvider");
  return ctx;
}

/** Register a shortcut for the lifetime of the calling component. */
export function useShortcut(
  keys: string,
  description: string,
  group: string,
  handler: () => void
) {
  const ctx = useContext(ShortcutContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const register = ctx?.register;

  useEffect(() => {
    if (!register) return;
    return register({
      keys,
      description,
      group,
      handler: () => handlerRef.current(),
    });
  }, [register, keys, description, group]);
}
