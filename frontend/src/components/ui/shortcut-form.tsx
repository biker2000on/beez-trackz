"use client";

import * as React from "react";

type ShortcutFormProps = React.ComponentProps<"form"> & {
  /** Submit this entry and prepare the same form for another one. */
  onSubmitAndReset?: () => void | Promise<void>;
  /** Close or cancel the form. Usually closes the containing dialog. */
  onEscape?: () => void;
};

/**
 * A form with the application's standard data-entry shortcuts.
 *
 * Ctrl/Cmd+Enter submits, Ctrl/Cmd+Shift+Enter submits and resets through the
 * supplied callback, and Escape closes modal forms. Keeping this behavior on
 * the form element prevents shortcuts in one dialog from reaching another.
 */
function ShortcutForm({
  onSubmitAndReset,
  onEscape,
  onKeyDown,
  ...props
}: ShortcutFormProps) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    const primaryModifier = event.ctrlKey || event.metaKey;
    if (primaryModifier && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey && onSubmitAndReset) {
        void onSubmitAndReset();
      } else {
        event.currentTarget.requestSubmit();
      }
      return;
    }

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

  return <form onKeyDown={handleKeyDown} {...props} />;
}

export { ShortcutForm };
