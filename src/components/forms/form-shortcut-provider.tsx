"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";

function getTargetElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}

function getOpenDialog(): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>("[role='dialog'][data-state='open']")
  );
  return dialogs.at(-1) ?? null;
}

function closeActiveSurface(target: HTMLElement | null): boolean {
  const dialog = getOpenDialog();
  if (dialog) {
    const closeButton = dialog.querySelector<HTMLButtonElement>(
      "[data-dialog-shortcut-close]"
    );
    closeButton?.click();
    return Boolean(closeButton);
  }

  const section = target?.closest<HTMLDetailsElement>(
    "details[data-close-on-escape][open]"
  );
  if (section) {
    section.open = false;
    return true;
  }

  return false;
}

function submitActiveForm(target: HTMLElement | null): boolean {
  const form = target?.closest<HTMLFormElement>("form");
  if (!form) return false;

  const submitter = form.querySelector<HTMLButtonElement | HTMLInputElement>(
    "button[type='submit']:not(:disabled), input[type='submit']:not(:disabled)"
  );

  if (submitter) {
    form.requestSubmit(submitter);
  } else {
    form.requestSubmit();
  }

  return true;
}

export function FormShortcutProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;

      const target = getTargetElement(event.target);

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        if (submitActiveForm(target)) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape" && closeActiveSurface(target)) {
        event.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return children;
}
