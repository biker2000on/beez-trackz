"use client";

import * as React from "react";

type ShortcutFormProps = React.ComponentProps<"form"> & {
  /** Submit this entry and prepare the same form for another one. */
  onSubmitAndReset?: () => void | Promise<void>;
  /** Close or cancel the form. Usually closes the containing dialog. */
  onEscape?: () => void;
};

/** The dialog-ish layer nearest the top of the stack, if one is open. */
function topmostLayer(): Element | null {
  const layers = document.querySelectorAll(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  return layers.length > 0 ? layers[layers.length - 1] : null;
}

/**
 * True when a keystroke should count as happening "inside" this form.
 *
 * Plain fields are a `contains` check, but Radix renders select, combobox, and
 * popover content in a portal at the end of `<body>`, so a keystroke typed
 * with a dropdown open never reaches the form it visually belongs to. Those
 * layers are matched back to the form through the `aria-controls` link Radix
 * puts on the trigger. A keystroke with nothing focused counts too, as long as
 * this form is the one inside the topmost open dialog.
 */
function formOwnsEvent(
  form: HTMLFormElement,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Node)) return false;
  if (form.contains(target)) return true;

  const element =
    target instanceof HTMLElement ? target : (target.parentElement ?? null);

  for (let node = element; node; node = node.parentElement) {
    if (!node.id) continue;
    const trigger = document.querySelector(
      `[aria-controls="${CSS.escape(node.id)}"]`,
    );
    if (trigger && form.contains(trigger)) return true;
  }

  // Portal content and un-focused clicks inside a modal still belong to the
  // form that modal contains; a form on the page behind it must not react.
  const layer = topmostLayer();
  if (layer?.contains(form)) {
    return (
      layer.contains(target) ||
      element === document.body ||
      element === document.documentElement ||
      element === null
    );
  }
  return false;
}

/**
 * A form with the application's standard data-entry shortcuts.
 *
 * Ctrl/Cmd+Enter submits, Ctrl/Cmd+Shift+Enter submits and resets through the
 * supplied callback, and Escape closes modal forms. Submit is handled on a
 * document-level capture listener rather than on the form element so it fires
 * from anywhere the form owns — including portaled dropdowns and controls that
 * stop their own key events — while `formOwnsEvent` keeps one form's shortcuts
 * from reaching another.
 */
function ShortcutForm({
  onSubmitAndReset,
  onEscape,
  onKeyDown,
  ref,
  ...props
}: ShortcutFormProps) {
  const innerRef = React.useRef<HTMLFormElement>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLFormElement);

  // Read the latest callbacks from a ref so the listener binds once.
  const handlersRef = React.useRef({ onSubmitAndReset });
  React.useEffect(() => {
    handlersRef.current = { onSubmitAndReset };
  });

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const form = innerRef.current;
      if (!form || !formOwnsEvent(form, event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      const submitAndReset = handlersRef.current.onSubmitAndReset;
      if (event.shiftKey && submitAndReset) {
        void submitAndReset();
      } else {
        form.requestSubmit();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  function handleFormKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (
      event.key === "Escape" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      onEscape
    ) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    }
  }

  return <form ref={innerRef} onKeyDown={handleFormKeyDown} {...props} />;
}

export { ShortcutForm };
