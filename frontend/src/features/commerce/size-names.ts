/**
 * Short jar-size names for the stall ("1 lb", "Qt", "Pt", "8 oz").
 *
 * Market day lists every sellable row as "varietal · size" beside a stepper,
 * and at 375px the long catalog labels ("Quart", "Half gallon") push the
 * name into an ellipsis. The replacement is word-for-word so a label the
 * table does not know ("12 oz Bear", "1 lb Queenline") passes through
 * untouched and nothing ever reads as a different size.
 */

const SHORT_WORDS: [RegExp, string][] = [
  [/\bhalf[\s-]?gallons?\b/gi, "½ gal"],
  [/\bgallons?\b/gi, "Gal"],
  [/\bhalf[\s-]?pints?\b/gi, "½ pt"],
  [/\bquarts?\b/gi, "Qt"],
  [/\bpints?\b/gi, "Pt"],
  [/\bounces?\b/gi, "oz"],
  [/\bpounds?\b/gi, "lb"],
  [/\bfluid oz\b/gi, "fl oz"],
];

export function shortSizeName(label: string): string {
  let short = label.trim();
  for (const [pattern, replacement] of SHORT_WORDS) {
    short = short.replace(pattern, replacement);
  }
  return short.replace(/\s{2,}/g, " ").trim();
}
