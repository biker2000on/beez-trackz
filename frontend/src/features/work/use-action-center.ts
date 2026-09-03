"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { isTypingTarget } from "@/lib/keyboard";

import type { WorkCommand, WorkItem } from "./types";

/**
 * The action-center keyboard controller, ported verbatim from the dashboard
 * (`features/dashboard/dashboard-view.tsx:139-215` before this wave) and
 * retargeted at `items[].commands[]` (design 2026-09-03 D8).
 *
 * What is preserved: arrows move a focus ring in exactly the visible order,
 * Enter (or `o`) opens the hive, letter keys resolve the focused row, the
 * armed-row guard means a letter can only fire after the operator has
 * arrow-focused that row this visit, and the focused row is revealed after
 * arrow movement.
 *
 * What changed, and why: the letters are no longer `d`/`s`/`r` hardcoded
 * against two item kinds. Each command carries its own key (`keyboard`) and
 * its own answer about whether this actor may run it (`permitted`), so a new
 * source type gets keyboard triage for free and a viewer's keypress does not
 * fire a request the server will refuse.
 */

/** The row attribute the armed-row guard and the reveal effect look for. */
export const WORK_ROW_ATTR = "data-work-id";

/** True while typing or while a dialog is open — keyboard triage stands down. */
function keyboardBusy(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true;
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  );
}

/** Mutations only fire after the user has arrow-focused a row this visit. */
function isArmedRow(focusedId: string, target: EventTarget | null): boolean {
  const node =
    (document.activeElement instanceof HTMLElement && document.activeElement) ||
    (target instanceof HTMLElement ? target : null);
  if (!node) return false;
  return node.closest(`[${WORK_ROW_ATTR}="${CSS.escape(focusedId)}"]`) != null;
}

/**
 * The command a key press resolves to on this item: the first command whose
 * `keyboard` matches. A denied command still matches — it is returned so the
 * caller can say why rather than swallowing the keypress silently.
 */
export function commandForKey(
  item: WorkItem,
  key: string,
): WorkCommand | undefined {
  return item.commands.find(
    (command) => command.keyboard && command.keyboard === key,
  );
}

export interface ActionCenterOptions {
  /** The items in the order they are rendered; the keyboard order is this. */
  items: WorkItem[];
  /** Run a command. Called only for an armed, focused, key-matched row. */
  onRun: (item: WorkItem, command: WorkCommand) => void;
  /** True while a command is in flight — keys stand down rather than queue. */
  busy: boolean;
  /** Where Enter goes. Defaults to the hive detail page. */
  hiveHref?: (hiveId: string) => string;
}

export function useActionCenter({
  items,
  onRun,
  busy,
  hiveHref = (hiveId) => `/hives/${hiveId}`,
}: ActionCenterOptions) {
  const router = useRouter();
  const [focusedIndex, setFocusedIndex] = React.useState(-1);
  const revealFocused = React.useRef(false);

  const focusIndex =
    focusedIndex < 0 || items.length === 0
      ? -1
      : Math.min(focusedIndex, items.length - 1);
  const focusedId = focusIndex >= 0 ? (items[focusIndex]?.id ?? null) : null;

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (keyboardBusy(event.target)) return;
      if (items.length === 0) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const current =
          focusIndex < 0 ? (direction > 0 ? -1 : items.length) : focusIndex;
        const next = Math.max(
          0,
          Math.min(items.length - 1, current + direction),
        );
        if (next !== focusIndex) revealFocused.current = true;
        setFocusedIndex(next);
        return;
      }

      const focused = focusIndex >= 0 ? items[focusIndex] : undefined;
      if (!focused) return;

      if (event.key === "Enter" || event.key === "o") {
        if (
          event.target instanceof Element &&
          event.target.closest("a, button")
        ) {
          return;
        }
        if (focused.context.hiveId) {
          event.preventDefault();
          router.push(hiveHref(focused.context.hiveId));
        }
        return;
      }

      if (event.key.length !== 1 || busy) return;
      const command = commandForKey(focused, event.key);
      if (!command) return;
      if (!isArmedRow(focused.id, event.target)) return;
      event.preventDefault();
      onRun(focused, command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, focusIndex, hiveHref, items, onRun, router]);

  // Reveal the focused row after arrow movement.
  React.useEffect(() => {
    if (!revealFocused.current) return;
    revealFocused.current = false;
    if (!focusedId) return;
    const row = document.querySelector<HTMLElement>(
      `[${WORK_ROW_ATTR}="${CSS.escape(focusedId)}"]`,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    const bounds = row.getBoundingClientRect();
    if (bounds.top < 16 || bounds.bottom > window.innerHeight - 16) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [focusedId]);

  return { focusedId, focusIndex, setFocusedIndex };
}
