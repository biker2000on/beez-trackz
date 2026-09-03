"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Download, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { navRootHrefs } from "@/components/shell/nav-items";

/** Chromium-only event fired when the PWA is installable. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_AT_KEY = "beez.install-prompt.dismissedAt";
const SESSION_COUNT_KEY = "beez.install-prompt.sessionCount";
const SESSION_SEEN_KEY = "beez.install-prompt.sessionSeen";

/** A dismissal is respected for this long before the banner may return. */
const DISMISS_DAYS = 120;
/** Repeat-visit threshold: never ask a first- or second-time visitor. */
const MIN_SESSIONS = 3;
/** Let a finished task settle before considering the prompt. */
const SETTLE_MS = 5_000;
/** How often the "is this a calm moment?" guard is re-evaluated. */
const GUARD_POLL_MS = 1_000;

/**
 * Routes where the user is browsing rather than doing: the seven area roots
 * plus the recommendations inbox. Detail, editing, transcription, auth and
 * public routes are deliberately absent — the prompt must never land on top
 * of in-progress field work.
 *
 * Derived from `NAV_ITEMS` rather than hand-written. The previous list had
 * drifted: it named a redirect-only route that never rendered at its own
 * pathname, and omitted two calm pages that did.
 */
const CALM_ROUTES = new Set([
  ...navRootHrefs(),
  "/today/recommendations",
]);

/**
 * Anything that means "the user is mid-task right now". Checked against live
 * DOM so no other feature has to report its state up to this component.
 */
const BUSY_SELECTOR = [
  '[data-slot="dialog-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="alert-dialog-content"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  // The audio recorder shows this control only while capturing.
  'button[aria-label="Stop recording"]',
  // The offline/sync banner owns the same bottom-of-screen slot.
  "[data-offline-banner]",
].join(",");

// ---------------------------------------------------------------------------
// Shared install store
//
// `beforeinstallprompt` fires once, early, and is never replayed. A component
// that only listens while mounted (a settings panel, say) will almost always
// miss it. Capturing it in a module-level store lets any part of the app offer
// installation later on. Platform checks and the persisted snooze live here
// too, so consumers read them through one browser-only snapshot instead of
// each doing their own post-mount setState.
// ---------------------------------------------------------------------------

type InstallSnapshot = {
  available: boolean;
  installed: boolean;
  ios: boolean;
  standalone: boolean;
  snoozed: boolean;
};

const SERVER_SNAPSHOT: InstallSnapshot = {
  available: false,
  installed: false,
  ios: false,
  standalone: false,
  snoozed: false,
};

let deferredEvent: BeforeInstallPromptEvent | null = null;
let installedFlag = false;
let snapshot: InstallSnapshot = SERVER_SNAPSHOT;
let bound = false;
const subscribers = new Set<() => void>();

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports as Mac but has touch points.
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function readNumber(key: string): number {
  try {
    return Number(window.localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Private mode / storage disabled — gating degrades to "don't ask again".
  }
}

/** True when a previous dismissal is still inside its quiet period. */
function readSnoozed(): boolean {
  const dismissedAt = readNumber(DISMISSED_AT_KEY);
  if (!dismissedAt) return false;
  return Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function emit() {
  snapshot = {
    available: deferredEvent !== null,
    installed: installedFlag,
    ios: isIOS(),
    standalone: isStandalone(),
    snoozed: readSnoozed(),
  };
  for (const notify of subscribers) notify();
}

function bindOnce() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredEvent = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferredEvent = null;
    installedFlag = true;
    emit();
  });
  // Publish the platform/snooze facts as soon as we are on the client.
  emit();
}

function subscribe(notify: () => void) {
  bindOnce();
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** Dismiss the automatic prompt for {@link DISMISS_DAYS} days. */
export function snoozeInstallPrompt() {
  writeNumber(DISMISSED_AT_KEY, Date.now());
  emit();
}

export function clearInstallPromptSnooze() {
  try {
    window.localStorage.removeItem(DISMISSED_AT_KEY);
  } catch {
    // Ignore — nothing was persisted in the first place.
  }
  emit();
}

/** Counts this browser session exactly once, and returns the running total. */
function countSession(): number {
  try {
    if (window.sessionStorage.getItem(SESSION_SEEN_KEY)) {
      return readNumber(SESSION_COUNT_KEY);
    }
    window.sessionStorage.setItem(SESSION_SEEN_KEY, "1");
  } catch {
    return 0;
  }
  const next = readNumber(SESSION_COUNT_KEY) + 1;
  writeNumber(SESSION_COUNT_KEY, next);
  return next;
}

/**
 * Shared installability state. Values are the SSR defaults until the store
 * binds on the client, so this is safe to call from server-rendered trees.
 */
export function useInstallPrompt() {
  const state = React.useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );

  const promptInstall = React.useCallback(async () => {
    if (!deferredEvent) return "unavailable" as const;
    const event = deferredEvent;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // The event is single-use either way.
    deferredEvent = null;
    emit();
    return outcome;
  }, []);

  return { ...state, promptInstall };
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

function isCalmMoment(pathname: string): boolean {
  if (!CALM_ROUTES.has(pathname)) return false;
  if (document.querySelector(BUSY_SELECTOR)) return false;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))
  ) {
    return false;
  }
  return true;
}

/**
 * Bottom-of-screen install invitation.
 *
 * Rules, in order:
 *  1. Never when already installed, running standalone, or un-installable
 *     (iOS gets guidance in Settings instead — Safari has no prompt event).
 *  2. Never inside the quiet period following a dismissal.
 *  3. Only after the app has earned it: a task completed in this session, or
 *     a third-or-later visit.
 *  4. Only at a calm moment — an overview route, no dialog/sheet open, no
 *     recording running, no field focused, no sync banner showing. If any of
 *     those start, the banner steps aside and returns when they finish.
 */
export function InstallPrompt() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { available, installed, standalone, snoozed, promptInstall } =
    useInstallPrompt();

  const [armed, setArmed] = React.useState(false);
  const [calm, setCalm] = React.useState(false);

  // Repeat-visit arming. Runs once per mount of the app shell.
  React.useEffect(() => {
    if (countSession() < MIN_SESSIONS) return undefined;
    const timer = window.setTimeout(() => setArmed(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Completed-task arming: any successful mutation means the user finished
  // something. Wait out SETTLE_MS so the ask never interrupts the follow-up.
  React.useEffect(() => {
    let timer = 0;
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.mutation?.state.status !== "success") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setArmed(true), SETTLE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [queryClient]);

  const eligible =
    armed && available && !installed && !standalone && !snoozed;

  // Re-evaluate the "not mid-task" guard while eligible. Polling keeps this
  // decoupled from every dialog, sheet and recorder in the app, and lets the
  // banner retreat the moment one of them opens.
  React.useEffect(() => {
    if (!eligible) return undefined;
    const interval = window.setInterval(
      () => setCalm(isCalmMoment(pathname)),
      GUARD_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [eligible, pathname]);

  if (!eligible || !calm) return null;

  async function install() {
    const outcome = await promptInstall();
    // Either answer settles it for a good while; the Settings card remains
    // available for anyone who changes their mind sooner.
    snoozeInstallPrompt();
    if (outcome === "unavailable") setArmed(false);
  }

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-[90] mx-auto flex max-w-lg flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg lg:bottom-4"
      role="complementary"
      aria-label="Install Beez Trackz"
    >
      <Download className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Install Beez Trackz</p>
        <p className="text-xs text-muted-foreground">
          Full screen, its own icon, and it keeps working out of signal range.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" className="min-h-11" onClick={() => void install()}>
          Install
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Not now — hide install prompt"
          onClick={snoozeInstallPrompt}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
