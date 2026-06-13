/**
 * Collect a FormData's string fields into a plain object so a server action
 * can echo the user's input back on a validation error. React 19 resets a
 * `<form action>` after the action runs, which clears uncontrolled inputs;
 * re-seeding `defaultValue` from these values preserves what was typed.
 */
export function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Shape an action returns on validation failure. */
export interface FormErrorState {
  error: string;
  values?: Record<string, string>;
}
