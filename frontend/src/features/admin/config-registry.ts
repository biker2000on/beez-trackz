/**
 * Every configuration object in the app, and the one surface that edits it.
 *
 * This is the machine-checkable half of the settings split's acceptance
 * criterion — "no configuration object has two editors" (design 2026-09-03
 * §6.5, wave 6). Each editor component carries
 * `data-config-editor="<key>"` on its root element, and
 * `tests/e2e/settings-split.spec.ts` walks every authenticated surface
 * collecting those attributes: a key that appears on two surfaces, or on a
 * surface other than the one named here, fails the suite.
 *
 * `contextualLinks` is the other half of the same design decision: an editor
 * that lives in Operation Setup has to be reachable from the workspace that
 * needs it, or it is invisible where it matters (S13, S14, S4).
 */
export interface ConfigObject {
  /** Value of `data-config-editor` on the editor's root element. */
  key: string;
  label: string;
  /** The single surface that may render the editor. */
  href: string;
  /** Anchor within that surface, for contextual "manage" links. */
  anchor?: string;
  /** Surfaces that link to the editor but must never render one. */
  contextualLinks?: string[];
}

export const CONFIG_OBJECTS: ConfigObject[] = [
  {
    key: "preferences",
    label: "My preferences (theme, units, formats)",
    href: "/me",
    anchor: "preferences",
  },
  {
    key: "api-tokens",
    label: "Your access and API tokens",
    href: "/me",
    anchor: "tokens",
  },
  {
    key: "jar-sizes",
    label: "Jar sizes",
    href: "/admin/setup",
    anchor: "jar-sizes",
    contextualLinks: ["/production/jars", "/sales/market-day"],
  },
  {
    key: "treatment-withdrawals",
    label: "Treatment withdrawals",
    href: "/admin/setup",
    anchor: "treatment-withdrawals",
    contextualLinks: ["/yard/hives"],
  },
  {
    key: "thresholds",
    label: "Thresholds and the labor flag",
    href: "/admin/setup",
    anchor: "thresholds",
    contextualLinks: ["/yard/queue"],
  },
  {
    key: "collaborators",
    label: "Apiary collaborators",
    href: "/admin",
    anchor: "access",
  },
  { key: "ai", label: "AI configuration", href: "/admin", anchor: "ai" },
  {
    key: "photo-storage",
    label: "Photo storage",
    href: "/admin",
    anchor: "storage",
  },
  { key: "ntfy", label: "Phone push (ntfy)", href: "/admin", anchor: "ntfy" },
  {
    key: "gnucash",
    label: "GnuCash credentials, book and mapping",
    href: "/admin",
    anchor: "gnucash",
    contextualLinks: ["/insights/reconciliation"],
  },
];

/** Every surface a configuration editor is allowed to appear on. */
export function configEditorSurfaces(): string[] {
  return Array.from(new Set(CONFIG_OBJECTS.map((object) => object.href)));
}
