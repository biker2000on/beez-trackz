"use client";

import { useEffect } from "react";

/**
 * React 19 resets a `<form action>` after its action runs, which wipes
 * uncontrolled inputs even when the action returned a validation error.
 * This restores the user's typed values (echoed back by the action as
 * `values`) into the form's native fields after that reset.
 *
 * Radix Selects/Checkboxes keep their own React state across the reset, so
 * only native text/number/date/textarea fields need restoring here.
 *
 * Usage:
 *   const formRef = useRef<HTMLFormElement>(null);
 *   useRestoreOnError(formRef, result?.values);
 *   <form ref={formRef} action={formAction}>
 */
export function useRestoreOnError(
  formRef: React.RefObject<HTMLFormElement | null>,
  values: Record<string, string> | undefined
) {
  useEffect(() => {
    const form = formRef.current;
    if (!values || !form) return;
    for (const [name, value] of Object.entries(values)) {
      const el = form.elements.namedItem(name);
      if (el instanceof HTMLInputElement) {
        if (["file", "hidden", "submit", "button", "checkbox", "radio"].includes(el.type)) {
          continue;
        }
        el.value = value;
      } else if (el instanceof HTMLTextAreaElement) {
        el.value = value;
      }
    }
  }, [values, formRef]);
}
