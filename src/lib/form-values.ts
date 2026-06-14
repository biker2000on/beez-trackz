const ACTION_STATE_FIELD_PREFIX = /^(\d+)_(.+)$/;

/**
 * React 19 action-state submissions can arrive at the action with field names
 * still scoped to the action argument index, e.g. `1_name` instead of `name`.
 */
export function normalizeFormData(formData: FormData): FormData {
  let hasActionStatePrefix = false;
  for (const key of formData.keys()) {
    if (ACTION_STATE_FIELD_PREFIX.test(key)) {
      hasActionStatePrefix = true;
      break;
    }
  }

  if (!hasActionStatePrefix) return formData;

  const normalized = new FormData();
  for (const [key, value] of formData.entries()) {
    const match = ACTION_STATE_FIELD_PREFIX.exec(key);
    if (match) {
      normalized.append(match[2], value);
    } else if (!/^\d+$/.test(key)) {
      normalized.append(key, value);
    }
  }
  return normalized;
}

/**
 * Collect a FormData's string fields into a plain object so a server action
 * can echo the user's input back on a validation error. React 19 resets a
 * `<form action>` after the action runs, which clears uncontrolled inputs;
 * re-seeding `defaultValue` from these values preserves what was typed.
 */
export function formValues(formData: FormData): Record<string, string> {
  formData = normalizeFormData(formData);
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
