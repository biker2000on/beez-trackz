"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Command, Keyboard, Search } from "lucide-react";

import {
  NAV_ITEMS,
  contextualNavRoutes,
  flattenNavRoutes,
  visibleNavItems,
  visibleNavRoutes,
} from "@/components/shell/nav-items";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isTypingTarget } from "@/lib/keyboard";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { useApiaries } from "@/features/apiaries/hooks";
import { useHarvestLots } from "@/features/commerce/api";
import { useHives } from "@/features/hives/hooks";
import { useHarvestSessions, useHoneySales } from "@/features/honey/hooks";

interface ShortcutEntry {
  key: string;
  description: string;
  handler: () => void;
}

interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  hint: string;
  searchText: string;
  contextKey?: string;
  run: () => void;
}

interface ShortcutsContextValue {
  register: (entry: ShortcutEntry) => () => void;
  openCommands: () => void;
}

const ShortcutsContext = React.createContext<ShortcutsContextValue | null>(
  null,
);

/** True when a Radix dialog/sheet/alert-dialog is currently open. */
function isDialogOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  );
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

/** Token-aware fuzzy score, including common one-character misspellings. */
function commandScore(command: PaletteCommand, query: string): number | null {
  const normalizedQuery = normalizeSearch(query);
  const haystack = normalizeSearch(
    `${command.label} ${command.description} ${command.searchText}`,
  );
  if (!normalizedQuery) return 0;
  const exactIndex = haystack.indexOf(normalizedQuery);
  if (exactIndex >= 0) return 1000 - exactIndex;

  const words = haystack.split(" ").filter(Boolean);
  let score = 0;
  for (const token of normalizedQuery.split(" ").filter(Boolean)) {
    const substringIndex = haystack.indexOf(token);
    if (substringIndex >= 0) {
      score += 100 - Math.min(substringIndex, 50);
      continue;
    }
    const tolerance = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0;
    let best = Number.POSITIVE_INFINITY;
    for (const word of words) {
      if (Math.abs(word.length - token.length) > tolerance) continue;
      best = Math.min(best, editDistance(token, word));
    }
    if (best > tolerance) return null;
    score += 30 - best * 5;
  }
  return score;
}

function uniqueCommands(commands: PaletteCommand[]) {
  return Array.from(
    new Map(commands.map((command) => [command.id, command])).values(),
  );
}

const GOTO_TIMEOUT_MS = 1500;
const MAX_SEARCH_RESULTS = 60;

export function ShortcutsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;
  const canEditAny =
    isAdmin || access.data?.memberships.some((entry) => entry.role === "editor") === true;
  const navigation = React.useMemo(
    () => visibleNavItems(NAV_ITEMS, isAdmin),
    [isAdmin],
  );

  const [helpOpen, setHelpOpen] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");
  const [activeCommand, setActiveCommand] = React.useState(0);
  const [entries, setEntries] = React.useState<Map<string, ShortcutEntry>>(
    () => new Map(),
  );
  const commandResultsRef = React.useRef<HTMLDivElement>(null);
  const commandItemRefs = React.useRef<Array<HTMLLIElement | null>>([]);

  // Ctrl-K is a live record index, not just a static page list. These queries
  // are shared with the rest of the app through React Query's cache.
  const apiaries = useApiaries(commandOpen);
  const hives = useHives({ includeArchived: true }, commandOpen);
  const sales = useHoneySales(isAdmin && commandOpen);
  const sessions = useHarvestSessions(isAdmin && commandOpen);
  const lots = useHarvestLots(isAdmin && commandOpen);
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
        event.preventDefault();
        clearGoto();
        const item = navigation.find(
          (nav) => nav.shortcutKey === key.toLowerCase(),
        );
        if (item) {
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

    // Capture so `g` chords preventDefault before page listeners (dashboard d/s/r).
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearGoto();
    };
  }, [navigation, router]);

  const pageShortcuts = Array.from(entries.values());
  const staticCommands = React.useMemo(() => {
    const routes = visibleNavRoutes(NAV_ITEMS, isAdmin, canEditAny);
    return flattenNavRoutes(routes).map<PaletteCommand>((route) => {
      const topLevel = route.breadcrumbs.length === 1
        ? navigation.find((item) => item.href === route.href)
        : undefined;
      return {
        id: `route:${route.href}`,
        label: route.breadcrumbs.join(" › "),
        description: route.href,
        hint: topLevel ? `g ${topLevel.shortcutKey}` : "Route",
        searchText: `${route.keywords?.join(" ") ?? ""} ${route.href}`,
        run: () => router.push(route.href),
      };
    });
  }, [canEditAny, isAdmin, navigation, router]);

  const recordCommands = React.useMemo(() => {
    const commands: PaletteCommand[] = [];
    for (const apiary of apiaries.data ?? []) {
      const role = apiaryRole(access.data, apiary.id);
      const canEdit = role === "admin" || role === "editor";
      const routes = visibleNavRoutes(
        contextualNavRoutes("/apiaries", `/apiaries/${apiary.id}`),
        isAdmin,
        canEdit,
      );
      for (const route of flattenNavRoutes(routes)) {
        commands.push({
          id: `apiary:${apiary.id}:${route.href}`,
          label: `Apiaries › ${apiary.name} › ${route.label}`,
          description: route.href,
          hint: "Apiary",
          contextKey: `apiary:${apiary.id}`,
          searchText: `apiary apiarty yard ${apiary.name} ${route.keywords?.join(" ") ?? ""}`,
          run: () => router.push(route.href),
        });
      }
    }

    for (const hive of hives.data ?? []) {
      const role = apiaryRole(access.data, hive.apiaryId);
      const canEdit = role === "admin" || role === "editor";
      const routes = visibleNavRoutes(
        contextualNavRoutes("/hives", `/hives/${hive.id}`),
        isAdmin,
        canEdit,
      );
      for (const route of flattenNavRoutes(routes)) {
        commands.push({
          id: `hive:${hive.id}:${route.href}`,
          label: `Hives › ${hive.apiaryName} › ${hive.positionLabel} › ${route.label}`,
          description: route.href,
          hint: "Hive",
          contextKey: `hive:${hive.id}`,
          searchText: `hive colony ${hive.positionLabel} ${hive.apiaryName} ${hive.status} ${route.keywords?.join(" ") ?? ""}`,
          run: () => router.push(route.href),
        });
      }
    }

    if (isAdmin) {
      for (const sale of sales.data ?? []) {
        const name =
          sale.orderNumber ??
          sale.customerName ??
          `${sale.date} ${sale.channel.replaceAll("_", " ")}`;
        const href = `/harvest/sales/${sale.id}`;
        commands.push({
          id: `sale:${sale.id}`,
          label: `Honey › Sales › ${name}`,
          description: href,
          hint: "Sale",
          searchText: `${sale.customerName ?? ""} ${sale.location ?? ""} ${sale.orderStatus} ${sale.paymentMethod} ${sale.totalAmount}`,
          run: () => router.push(href),
        });
      }
      for (const session of sessions.data ?? []) {
        const href = `/harvest/sessions/${session.id}`;
        commands.push({
          id: `session:${session.id}`,
          label: `Honey › Production › ${session.apiaryName} extraction ${session.date}`,
          description: href,
          hint: "Session",
          searchText: `${session.apiaryName} ${session.notes ?? ""} harvest extraction session`,
          run: () => router.push(href),
        });
      }
      for (const lot of lots.data ?? []) {
        if (!lot.isPublic || !lot.publicSlug) continue;
        const href = `/honey/${lot.publicSlug}`;
        commands.push({
          id: `lot-story:${lot.id}`,
          label: `Honey › Lots › ${lot.lotCode} story`,
          description: href,
          hint: "Lot",
          searchText: `${lot.lotCode} ${lot.honeyVariety ?? ""} ${lot.season ?? ""} ${lot.apiaryRegion ?? ""} public story traceability`,
          run: () => router.push(href),
        });
      }
    }
    return commands;
  }, [
    access.data,
    apiaries.data,
    hives.data,
    isAdmin,
    lots.data,
    router,
    sales.data,
    sessions.data,
  ]);

  const pageCommands = pageShortcuts.map<PaletteCommand>((entry) => ({
    id: `page:${entry.key}`,
    label: entry.description,
    description: "Action on this page",
    hint: entry.key,
    searchText: `action ${entry.description}`,
    run: entry.handler,
  }));

  const currentApiaryId = pathname.match(/^\/apiaries\/([^/]+)/)?.[1];
  const currentHiveId = pathname.match(/^\/hives\/([^/]+)/)?.[1];
  const contextCommands = recordCommands.filter(
    (command) =>
      command.contextKey === `apiary:${currentApiaryId}` ||
      command.contextKey === `hive:${currentHiveId}`,
  );
  const normalizedQuery = commandQuery.trim();
  const filteredCommands = normalizedQuery
    ? uniqueCommands([...staticCommands, ...recordCommands, ...pageCommands])
        .map((command) => ({
          command,
          score: commandScore(command, normalizedQuery),
        }))
        .filter(
          (entry): entry is { command: PaletteCommand; score: number } =>
            entry.score != null,
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_SEARCH_RESULTS)
        .map((entry) => entry.command)
    : uniqueCommands([...contextCommands, ...pageCommands, ...staticCommands]);
  const indexing =
    apiaries.isPending ||
    hives.isPending ||
    (isAdmin && (sales.isPending || sessions.isPending || lots.isPending));

  React.useLayoutEffect(() => {
    const results = commandResultsRef.current;
    const activeItem = commandItemRefs.current[activeCommand];
    if (!commandOpen || !results || !activeItem) return;

    const resultsBounds = results.getBoundingClientRect();
    const itemBounds = activeItem.getBoundingClientRect();
    if (itemBounds.top < resultsBounds.top) {
      results.scrollTop -= resultsBounds.top - itemBounds.top;
    } else if (itemBounds.bottom > resultsBounds.bottom) {
      results.scrollTop += itemBounds.bottom - resultsBounds.bottom;
    }
  }, [activeCommand, commandOpen, filteredCommands.length]);

  function runCommand(command: PaletteCommand) {
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
              Press <Kbd>g</Kbd> then a letter to jump between sections, or{" "}
              <Kbd>Ctrl/⌘ K</Kbd> to search every route, apiary, and hive.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Navigation
              </h3>
              <ul className="grid gap-1.5">
                {navigation.map((item) => (
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
                  <span>Search routes and records</span>
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
        <DialogContent className="top-[10%] max-w-[calc(100%-2rem)] translate-y-0 gap-2 overflow-hidden p-3 sm:top-[15%] sm:max-w-3xl">
          <DialogHeader className="sr-only">
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>
              Search every application route, apiary, hive, and available page action.
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
                    Math.min(
                      current + 1,
                      Math.max(filteredCommands.length - 1, 0),
                    ),
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
              placeholder="Search routes, apiaries, hives, sales…"
              aria-label="Search commands"
              className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div
            ref={commandResultsRef}
            data-command-results
            className="max-h-[min(60vh,28rem)] min-w-0 overflow-x-hidden overflow-y-auto py-1"
          >
            {filteredCommands.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {indexing ? "Still indexing records…" : "No matching routes or records"}
              </p>
            ) : (
              <ul className="grid gap-1">
                {filteredCommands.map((command, index) => (
                  <li
                    key={command.id}
                    ref={(node) => {
                      commandItemRefs.current[index] = node;
                    }}
                    className="min-w-0 overflow-hidden"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      aria-current={index === activeCommand ? "true" : undefined}
                      className={`h-auto min-h-12 w-full min-w-0 max-w-full justify-start overflow-hidden px-3 py-2 ${
                        index === activeCommand ? "bg-secondary" : ""
                      }`}
                      onMouseEnter={() => setActiveCommand(index)}
                      onClick={() => runCommand(command)}
                    >
                      <Command className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate">{command.label}</span>
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {command.description}
                        </span>
                      </span>
                      <Kbd>{command.hint}</Kbd>
                      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
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
    <kbd className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
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
      aria-label="Search everything"
      className="w-full min-w-0 justify-start gap-2 overflow-hidden px-2 text-muted-foreground"
      onClick={context.openCommands}
    >
      <Search className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">Search</span>
      <span className="shrink-0">
        <Kbd>Ctrl K</Kbd>
      </span>
    </Button>
  );
}
