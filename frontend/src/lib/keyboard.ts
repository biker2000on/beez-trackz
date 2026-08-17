/** True when the event originates from a place where typing is expected. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  ) {
    return true;
  }
  return (
    target.closest(
      '[role="combobox"], [role="listbox"], [role="menu"], [role="option"]',
    ) != null
  );
}
