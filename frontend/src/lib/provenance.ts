/**
 * Import provenance folded out of operator-facing text.
 *
 * Records brought in by the Obsidian history import carry their lineage
 * inside the notes field itself, as bracketed segments:
 *
 *   [Obsidian import:obsidian-history-v3-identity; Journal 2025.md; 2025-09-22; current-D1]
 *   [Obsidian identity:obsidian-history-v3-identity; key=current-D1]
 *   [Obsidian queen:obsidian-history-v3-identity; key=q-2026-a1-swarm]
 *
 * and, on apiaries, the sentence "Created by the curated Obsidian history
 * import." That lineage is worth keeping (it says which journal page a fact
 * came from) but it is not the note. `splitProvenance` separates the two so
 * the body reads as the operator wrote it and the sources go behind a quiet
 * "Source" disclosure (`components/record/source-note.tsx`).
 */

export interface ProvenanceSource {
  /** What kind of source: "Obsidian import", "Obsidian identity", … */
  label: string;
  /** The remaining fields of the segment, in order: file, date, key. */
  parts: string[];
  /** The segment exactly as it was stored. */
  raw: string;
}

export interface Provenance {
  /** The text with every provenance segment removed and whitespace tidied. */
  body: string;
  sources: ProvenanceSource[];
}

/**
 * `[<system> import: …]` / `[<system> identity: …]`, never nested — plus any
 * other `[Obsidian <kind>: …]` segment the importer wrote (queens carry
 * `[Obsidian queen: …]`).
 */
const BRACKETED =
  /\[([^[\]]*?\b(?:import|identity)|Obsidian\s+\w+)\s*:\s*([^[\]]*)\]/gi;

/** The one-sentence form the apiary importer wrote into notes. */
const SENTENCE = /\b(?:Created|Imported) by the (?:curated )?(\w+) (?:history )?import\.?/gi;

const EMPTY: Provenance = { body: "", sources: [] };

/**
 * Split `text` into the note the operator should read and the import
 * sources it carried. Returns an empty body and no sources for blank input.
 */
export function splitProvenance(text: string | null | undefined): Provenance {
  if (!text) return EMPTY;
  const sources: ProvenanceSource[] = [];

  let body = text.replace(BRACKETED, (raw, kind: string, rest: string) => {
    const label = kind.trim().replace(/\s+/g, " ");
    const parts = rest
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    sources.push({ label: titleCase(label), parts, raw });
    return " ";
  });

  body = body.replace(SENTENCE, (raw, system: string) => {
    sources.push({
      label: `${titleCase(system)} history import`,
      parts: [],
      raw,
    });
    return " ";
  });

  return { body: tidy(body), sources };
}

/** Just the readable note; for grid cells and one-line labels. */
export function provenanceBody(text: string | null | undefined): string {
  return splitProvenance(text).body;
}

/** One line per source, for a tooltip or `title`. */
export function describeSource(source: ProvenanceSource): string {
  return source.parts.length
    ? `${source.label} · ${source.parts.join(" · ")}`
    : source.label;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Collapse the gaps a removed segment leaves, keeping paragraph breaks. */
function tidy(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/\s+([.,;:])/g, "$1").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
