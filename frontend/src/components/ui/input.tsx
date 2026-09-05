import * as React from "react";

import { cn } from "@/lib/utils";
import { evaluateNumericInput } from "@/lib/math-input";

function localISODate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Numeric fields accept arithmetic ("12+12+12", "3*12 lb") and evaluate it
 * on blur or Enter, so counting boxes and multiplying by jars per box is one
 * entry. `type="number"` is rendered as a text field with a decimal keyboard
 * because the native number input refuses the operator characters; min/max/
 * step still travel as attributes for anything that reads them.
 */
function isNumeric(type: string | undefined, inputMode: string | undefined) {
  return type === "number" || inputMode === "decimal" || inputMode === "numeric";
}

function evaluateField(input: HTMLInputElement) {
  const evaluated = evaluateNumericInput(input.value);
  if (evaluated !== null && evaluated !== input.value) {
    setNativeInputValue(input, evaluated);
  }
}

function Input({
  className,
  type,
  inputMode,
  onKeyDown,
  onBlur,
  ...props
}: React.ComponentProps<"input">) {
  const numeric = isNumeric(type, inputMode);
  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    if (numeric) evaluateField(event.currentTarget);
    onBlur?.(event);
  }
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (numeric && event.key === "Enter" && !event.defaultPrevented) {
      evaluateField(event.currentTarget);
    }
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      type !== "date" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }

    const increment = event.key === "+" || event.key === "=";
    const decrement = event.key === "-";
    const today = event.key === "t" || event.key === "T";
    if (!increment && !decrement && !today) return;

    event.preventDefault();
    const date = today ? new Date() : dateFromInput(event.currentTarget.value);
    if (increment) date.setDate(date.getDate() + 1);
    if (decrement) date.setDate(date.getDate() - 1);
    setNativeInputValue(event.currentTarget, localISODate(date));
  }

  return (
    <input
      type={numeric && type === "number" ? "text" : type}
      inputMode={inputMode ?? (type === "number" ? "decimal" : undefined)}
      data-numeric={numeric ? "true" : undefined}
      data-slot="input"
      data-date-shortcuts={type === "date" ? "true" : undefined}
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
        "placeholder:text-muted-foreground",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/30",
        className,
      )}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      {...props}
    />
  );
}

export { Input };
