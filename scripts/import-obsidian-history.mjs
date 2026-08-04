import { execFileSync, spawnSync } from "node:child_process";

const dockerContext = process.env.BEEZ_DOCKER_CONTEXT || "truenas";
const dbContainer = process.env.BEEZ_DB_CONTAINER || "beez-trackz-db-1";
const dbUser = process.env.BEEZ_DB_USER || "beeztrackz";
const dbName = process.env.BEEZ_DB_NAME || "beeztrackz";

const importTag = "obsidian-history-v3-identity";
const previousImportTags = [
  "obsidian-history-v1",
  "obsidian-history-v2-curated",
  importTag,
];

const currentLabels = [
  "A1", "A2", "A3", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D1", "D2", "D3", "D4",
];

function source(file, date, detail) {
  return `[Obsidian import:${importTag}; ${file}; ${date}${detail ? `; ${detail}` : ""}]`;
}

function identityMarker(key) {
  return `[Obsidian identity:${importTag}; key=${key}]`;
}

function queenMarker(key) {
  return `[Obsidian queen:${importTag}; key=${key}]`;
}

function q(value) {
  if (value == null) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ts(value) {
  return `${q(value)}::timestamptz`;
}

function json(value) {
  return value == null ? "null" : `${q(JSON.stringify(value))}::jsonb`;
}

function apiaryId() {
  return "(select id from apiaries where name = 'Lenoir Apiary' order by created_at limit 1)";
}

function identityId(key) {
  return `(select id from hives where notes like ${q(`%${identityMarker(key)}%`)} order by created_at limit 1)`;
}

function queenId(key) {
  return `(select id from queens where notes like ${q(`%${queenMarker(key)}%`)} order by created_at limit 1)`;
}

/**
 * A hive UUID is a colony identity. A1, B2, and similar values are physical
 * positions which may be occupied by different identities over time.
 *
 * "installed" is the first supported date for the identity, not necessarily
 * the date the original bees were acquired. Where the journal first assigned
 * numbered positions on 2024-07-16, the notes say that explicitly.
 */
const identities = [
  // Current colonies. These reuse the 16 existing, non-archived hive rows.
  {
    key: "current-A1",
    currentLabel: "A1",
    installed: "2026-04-27",
    note: "Current A1: swarm caught 2026-04-27; combined with the failing early-season A2 colony on 2026-05-04.",
    locations: [["2026-04-27", null, "A1"]],
  },
  {
    key: "current-A2",
    currentLabel: "A2",
    installed: "2026-05-04",
    note: "Current A2: queen-right top deep split from B4 on 2026-05-04.",
    locations: [["2026-05-04", null, "A2"]],
  },
  {
    key: "current-A3",
    currentLabel: "A3",
    installed: "2026-04-10",
    note: "Current A3: inferred to be the successfully retained 2026-04-10 swarm first hived at A1, then moved from A1 to A3 on 2026-04-19. The journal is explicit about the move but not the Apr 10 starting slot.",
    locations: [
      ["2026-04-10", "2026-04-19", "A1 (swarm nuc)"],
      ["2026-04-19", null, "A3"],
    ],
  },
  {
    key: "current-A4",
    currentLabel: "A4",
    installed: "2024-07-16",
    note: "Current A4: the colony numbered Hive 4 at A4 on 2024-07-16. The colony predates the first numbered yard map.",
    locations: [
      ["2024-07-16", "2026-03-22", "A4"],
      ["2026-03-22", "2026-04-19", "A4 (bottom)"],
      ["2026-04-19", null, "A4"],
    ],
  },
  {
    key: "current-B1",
    currentLabel: "B1",
    installed: "2026-03-15",
    note: "Current B1: queen-right top half of the C1 split made 2026-03-15 and moved to B1 on 2026-04-12.",
    locations: [
      ["2026-03-15", "2026-04-12", "C1 (top)"],
      ["2026-04-12", null, "B1"],
    ],
  },
  {
    key: "current-B2",
    currentLabel: "B2",
    installed: "2025-04-03",
    note: "Current B2: swarm caught 2025-04-03 and hived at B2. It absorbed the failing prior B1 colony on 2026-03-28.",
    locations: [["2025-04-03", null, "B2"]],
  },
  {
    key: "current-B3",
    currentLabel: "B3",
    installed: "2026-04-04",
    note: "Current B3: swarm caught and hived at B3 on 2026-04-04; upsized from a nuc to a full deep on 2026-05-18.",
    locations: [
      ["2026-04-04", "2026-05-18", "B3 (swarm nuc)"],
      ["2026-05-18", null, "B3"],
    ],
  },
  {
    key: "current-B4",
    currentLabel: "B4",
    installed: "2025-04-13",
    note: "Current B4: nuc split made from C4 brood and queen-cell resources on 2025-04-13. Its queen-right top was split to A2 on 2026-05-04; the bottom remained at B4.",
    locations: [
      ["2025-04-13", "2026-05-04", "B4"],
      ["2026-05-04", "2026-05-04 12:00:00", "B4 (bottom)"],
      ["2026-05-04 12:00:00", null, "B4"],
    ],
  },
  {
    key: "current-C1",
    currentLabel: "C1",
    installed: "2025-04-03",
    note: "Current C1: top half of the C4 split moved to C1 on 2025-04-03. The bottom stayed at C1 after the 2026-03-15 split; the top became current B1.",
    locations: [
      ["2025-04-03", "2026-03-15", "C1"],
      ["2026-03-15", "2026-04-12", "C1 (bottom)"],
      ["2026-04-12", null, "C1"],
    ],
  },
  {
    key: "current-C2",
    currentLabel: "C2",
    installed: "2026-05-18",
    note: "Current C2: top half of the D3 split made and moved to the vacant C2 position on 2026-05-18.",
    locations: [["2026-05-18", null, "C2"]],
  },
  {
    key: "current-C3",
    currentLabel: "C3",
    installed: "2024-07-16",
    note: "Current C3: the colony numbered Hive 10 at C3 on 2024-07-16. The bottom remained at C3 after the 2026-03-28 split; its top became current D4.",
    locations: [
      ["2024-07-16", "2026-03-28", "C3"],
      ["2026-03-28", "2026-04-25", "C3 (bottom)"],
      ["2026-04-25", null, "C3"],
    ],
  },
  {
    key: "current-C4",
    currentLabel: "C4",
    installed: "2024-07-16",
    note: "Current C4: the colony numbered Hive 11 at C4 on 2024-07-16. It is the continuing parent of several later splits.",
    locations: [
      ["2024-07-16", "2026-03-15", "C4"],
      ["2026-03-15", "2026-04-12", "C4 (bottom)"],
      ["2026-04-12", null, "C4"],
    ],
  },
  {
    key: "current-D1",
    currentLabel: "D1",
    installed: "2025-04-03",
    note: "Current D1: top half of the A1 split made 2025-04-03 and moved to D1 on 2025-04-17. A 2026-03-22 split attempt was undone on 2026-03-28.",
    locations: [
      ["2025-04-03", "2025-04-17", "A1 (top)"],
      ["2025-04-17", null, "D1"],
    ],
  },
  {
    key: "current-D2",
    currentLabel: "D2",
    installed: "2026-04-04",
    note: "Current D2: swarm caught and hived at D2 on 2026-04-04; upsized from a nuc to a full deep on 2026-05-18.",
    locations: [
      ["2026-04-04", "2026-05-18", "D2 (swarm nuc)"],
      ["2026-05-18", null, "D2"],
    ],
  },
  {
    key: "current-D3",
    currentLabel: "D3",
    installed: "2025-03-19",
    note: "Current D3: queen-right top half of the A3 split made 2025-03-19 and moved to D3 on 2025-04-17. Its top was split to current C2 on 2026-05-18.",
    locations: [
      ["2025-03-19", "2025-04-17", "A3 (top)"],
      ["2025-04-17", "2026-05-18", "D3"],
      ["2026-05-18", "2026-05-18 12:00:00", "D3 (bottom)"],
      ["2026-05-18 12:00:00", null, "D3"],
    ],
  },
  {
    key: "current-D4",
    currentLabel: "D4",
    installed: "2026-03-28",
    note: "Current D4: queen-right top half of the C3 split made 2026-03-28 and moved to D4 on 2026-04-19.",
    locations: [
      ["2026-03-28", "2026-04-19", "C3 (top)"],
      ["2026-04-19", null, "D4"],
    ],
  },

  // Historical identities which no longer occupy a current slot.
  {
    key: "2024-swarm-parent",
    positionLabel: "Unrecorded (2024 swarm)",
    installed: "2024-03-31",
    status: "combined",
    archived: true,
    ended: "2024-06-24",
    note: "The original 2024 swarm colony, caught 2024-03-31 and split into three nucs on 2024-06-24. Its pre-split physical slot was not written down.",
    locations: [["2024-03-31", "2024-06-24", "Unrecorded (2024 swarm)"]],
  },
  {
    key: "2024-N1",
    positionLabel: "B2 (N1)",
    installed: "2024-06-24",
    status: "dead",
    archived: true,
    ended: "2025-03-02",
    note: "N1, one of three nucs made from the original 2024 swarm. It shared B2 with N2 on the first numbered map. It was absent from the 2025-03-02 survivor census, so the exact loss date is unknown.",
    locations: [["2024-06-24", "2025-03-02", "B2 (N1)"]],
  },
  {
    key: "2024-N2",
    positionLabel: "B2 (N2)",
    installed: "2024-06-24",
    status: "dead",
    archived: true,
    ended: "2025-03-02",
    note: "N2, one of three nucs made from the original 2024 swarm. It shared B2 with N1. It was absent from the 2025-03-02 survivor census, so the exact loss date is unknown.",
    locations: [["2024-06-24", "2025-03-02", "B2 (N2)"]],
  },
  {
    key: "2024-N3",
    positionLabel: "C1 (N3)",
    installed: "2024-06-24",
    status: "dead",
    archived: true,
    ended: "2024-08-19",
    note: "N3, one of three nucs made from the original 2024 swarm. Recorded as dying on 2024-07-31 and again on 2024-08-19.",
    locations: [["2024-06-24", "2024-08-19", "C1 (N3)"]],
  },
  {
    key: "2024-N4",
    positionLabel: "D1 (N4)",
    installed: "2024-04-16",
    status: "dead",
    archived: true,
    ended: "2025-03-02",
    note: "N4 at D1. It is probably the very small top-box split moved to a nuc on 2024-04-16, but that origin is not explicit. The 2025-03-02 census records the D1 nuc as a winter deadout.",
    locations: [
      ["2024-04-16", "2024-07-16", "Unrecorded (probable top-box split)"],
      ["2024-07-16", "2025-03-02", "D1 (N4)"],
    ],
  },
  {
    key: "2024-A1",
    positionLabel: "A1",
    installed: "2024-07-16",
    status: "dead",
    archived: true,
    ended: "2026-02-18",
    note: "Hive 1 at A1 on the first numbered map. It remained the A1 parent after its 2025 split and absorbed the failing 2024-A3 colony on 2025-09-22. Recorded as a winter deadout on 2026-02-18.",
    locations: [["2024-07-16", "2026-02-18", "A1"]],
  },
  {
    key: "2024-A2",
    positionLabel: "A2",
    installed: "2024-07-16",
    status: "dead",
    archived: true,
    ended: "2026-02-18",
    note: "Hive 2 at A2 on the first numbered map; the high-mite colony in 2024. Recorded as a winter deadout on 2026-02-18.",
    locations: [["2024-07-16", "2026-02-18", "A2"]],
  },
  {
    key: "2024-A3",
    positionLabel: "A3",
    installed: "2024-07-16",
    status: "combined",
    archived: true,
    ended: "2025-09-22",
    note: "Hive 3 at A3 on the first numbered map. Its top became current D3 in 2025. The remaining A3 colony was queenless and stacked/combined onto A1 on 2025-09-22.",
    locations: [["2024-07-16", "2025-09-22", "A3"]],
  },
  {
    key: "2024-B1",
    positionLabel: "B1",
    installed: "2024-07-16",
    status: "combined",
    archived: true,
    ended: "2026-03-28",
    note: "Hive 5 at B1 on the first numbered map. It struggled in spring 2026 and was paper-combined onto B2 on 2026-03-28.",
    locations: [["2024-07-16", "2026-03-28", "B1"]],
  },
  {
    key: "2024-B3",
    positionLabel: "B3",
    installed: "2024-07-16",
    status: "dead",
    archived: true,
    ended: "2025-03-02",
    note: "Hive 7 at B3 on the first numbered map; recorded as a winter deadout on 2025-03-02.",
    locations: [["2024-07-16", "2025-03-02", "B3"]],
  },
  {
    key: "2024-B4",
    positionLabel: "B4",
    installed: "2024-07-16",
    status: "dead",
    archived: true,
    ended: "2025-03-02",
    note: "Hive 8 at B4 on the first numbered map; recorded as a winter deadout on 2025-03-02.",
    locations: [["2024-07-16", "2025-03-02", "B4"]],
  },
  {
    key: "2024-C2",
    positionLabel: "C2",
    installed: "2024-07-16",
    status: "dead",
    archived: true,
    ended: "2026-02-18",
    note: "Hive 9 at C2 on the first numbered map. Its 2025 top became the later B3 colony. The C2 parent was recorded as a winter deadout on 2026-02-18.",
    locations: [["2024-07-16", "2026-02-18", "C2"]],
  },
  {
    key: "2024-D2-swarm",
    positionLabel: "D2",
    installed: "2024-07-31",
    status: "dead",
    archived: true,
    ended: "2025-03-02",
    note: "Swarm caught and added at D2 on 2024-07-31. It was doing well on 2024-08-19 but was absent from the 2025-03-02 survivor census; exact loss date is unknown.",
    locations: [["2024-07-31", "2025-03-02", "D2"]],
  },
  {
    key: "2025-B3",
    positionLabel: "B3",
    installed: "2025-04-03",
    status: "dead",
    archived: true,
    ended: "2026-02-18",
    note: "Top portion of the C2 split made 2025-04-03 and moved to B3 on 2025-04-17. Recorded as a winter deadout on 2026-02-18.",
    locations: [
      ["2025-04-03", "2025-04-17", "C2 (top)"],
      ["2025-04-17", "2026-02-18", "B3"],
    ],
  },
  {
    key: "2025-D2",
    positionLabel: "D2",
    installed: "2025-04-28",
    status: "dead",
    archived: true,
    ended: "2025-08-22",
    note: "Queen-cell nuc split from C4 on 2025-04-28. It was nearly dead on 2025-06-11 and showed probable laying-worker/drone brood later. It was absent from the explicit 15-hive census on 2025-08-22; exact loss date is unknown.",
    locations: [["2025-04-28", "2025-08-22", "D2"]],
  },
  {
    key: "2025-D4",
    positionLabel: "D4",
    installed: "2025-03-19",
    status: "dead",
    archived: true,
    ended: "2026-03-01",
    note: "Queen-right top half of the A4 split made 2025-03-19 and moved to D4 on 2025-04-17. Recorded dead/queenless on 2026-03-01.",
    locations: [
      ["2025-03-19", "2025-04-17", "A4 (top)"],
      ["2025-04-17", "2026-03-01", "D4"],
    ],
  },
  {
    key: "2026-A1-sold",
    positionLabel: "A1",
    installed: "2026-03-22",
    status: "sold",
    archived: true,
    ended: "2026-04-25",
    note: "Top half of the A4 split made 2026-03-22. It moved to A3 on 2026-04-12; its newly mated queen returned to A4's honey super and the queen/brood frames were moved to A1 on 2026-04-19. Sold to Craig on 2026-04-25.",
    locations: [
      ["2026-03-22", "2026-04-12", "A4 (top)"],
      ["2026-04-12", "2026-04-19", "A3"],
      ["2026-04-19", "2026-04-19 12:00:00", "A4 (honey super)"],
      ["2026-04-19 12:00:00", "2026-04-25", "A1"],
    ],
  },
  {
    key: "2026-C2-sold",
    positionLabel: "C2",
    installed: "2026-03-15",
    status: "sold",
    archived: true,
    ended: "2026-04-25",
    note: "Top half of the C4 split made 2026-03-15 and moved to C2 on 2026-04-12. Sold to Craig on 2026-04-25.",
    locations: [
      ["2026-03-15", "2026-04-12", "C4 (top)"],
      ["2026-04-12", "2026-04-25", "C2"],
    ],
  },
  {
    key: "2026-A2-early",
    positionLabel: "A2",
    installed: "2026-04-10",
    status: "combined",
    archived: true,
    ended: "2026-05-04",
    note: "Early-season A2 nuc/swarm identity. The journal classifies it with the April swarm/nuc group but does not state its exact origin. It became a laying-worker/failing colony and was combined into current A1 on 2026-05-04.",
    locations: [["2026-04-10", "2026-05-04", "A2"]],
  },
];

const splits = [
  ["2024-06-24", "2024-swarm-parent", "2024-N1", "nuc", null, "Original 2024 swarm colony split down into three nucs."],
  ["2024-06-24", "2024-swarm-parent", "2024-N2", "nuc", null, "Original 2024 swarm colony split down into three nucs."],
  ["2024-06-24", "2024-swarm-parent", "2024-N3", "nuc", null, "Original 2024 swarm colony split down into three nucs."],
  ["2025-03-19", "2024-A3", "current-D3", "vertical", null, "A3 queen-right top half; moved to D3 on 2025-04-17."],
  ["2025-03-19", "current-A4", "2025-D4", "vertical", null, "A4 queen-right top half; moved to D4 on 2025-04-17."],
  ["2025-04-03", "2024-A1", "current-D1", "vertical", null, "A1 top half; moved to D1 on 2025-04-17."],
  ["2025-04-03", "2024-C2", "2025-B3", "vertical", null, "C2 top half; moved to B3 on 2025-04-17."],
  ["2025-04-03", "current-C4", "current-C1", "vertical", null, "C4 top moved to C1."],
  ["2025-04-13", "current-C4", "current-B4", "nuc", 2, "B4 nuc made with two brood frames from C4 plus queen-cell resources."],
  ["2025-04-28", "current-C4", "2025-D2", "nuc", 2, "Queenless C4 divided into two queen-cell nucs; the second was placed at D2."],
  ["2026-03-15", "current-C1", "current-B1", "vertical", null, "C1 queen-right top; moved to B1 on 2026-04-12."],
  ["2026-03-15", "current-C4", "2026-C2-sold", "vertical", null, "C4 top; moved to C2 on 2026-04-12 and sold 2026-04-25."],
  ["2026-03-22", "current-A4", "2026-A1-sold", "vertical", null, "A4 top; later moved through A3/A4 to A1 and sold 2026-04-25."],
  ["2026-03-28", "current-C3", "current-D4", "vertical", null, "C3 queen-right top; moved to D4 on 2026-04-19."],
  ["2026-05-04", "current-B4", "current-A2", "vertical", null, "B4 queen-right top deep moved to A2; bottom remained at B4."],
  ["2026-05-18", "current-D3", "current-C2", "vertical", null, "D3 top half moved to the vacant C2 position."],
];

const inspections = [
  // First position-numbered inspection: identity mapping is explicit.
  ["2024-07-16", ["2024-A1"], "Journal 2024.md", "Mite wash: 2 mites per half-cup bee sample.", { pests: [{ type: "mites", count: 2, sample: "1/2 cup" }] }],
  ["2024-07-16", ["2024-A2"], "Journal 2024.md", "Mite wash: 14 mites per half-cup bee sample.", { pests: [{ type: "mites", count: 14, sample: "1/2 cup" }] }],
  ["2024-07-16", ["2024-A3"], "Journal 2024.md", "Mite wash: 2 mites per half-cup bee sample.", { pests: [{ type: "mites", count: 2, sample: "1/2 cup" }] }],
  ["2024-07-16", ["current-A4"], "Journal 2024.md", "Mite wash: 1 mite per half-cup bee sample.", { pests: [{ type: "mites", count: 1, sample: "1/2 cup" }] }],
  ["2024-07-16", ["2024-B1"], "Journal 2024.md", "Hive 5 was queenless with no brood; received a frame from N1 with eggs, young larvae, and queen cups.", { queenSeen: false, broodPattern: "no brood" }],
  ["2024-07-16", ["2024-B3"], "Journal 2024.md", "Mite wash: 0 mites per half-cup bee sample.", { pests: [{ type: "mites", count: 0, sample: "1/2 cup" }] }],
  ["2024-07-16", ["2024-B4"], "Journal 2024.md", "Mite wash: 2 mites per half-cup bee sample.", { pests: [{ type: "mites", count: 2, sample: "1/2 cup" }] }],
  ["2024-07-16", ["2024-C2"], "Journal 2024.md", "Mite wash: 0 mites per half-cup bee sample.", { pests: [{ type: "mites", count: 0, sample: "1/2 cup" }] }],
  ["2024-07-16", ["current-C3", "current-C4"], "Journal 2024.md", "Mite wash: 1 mite per half-cup bee sample.", { pests: [{ type: "mites", count: 1, sample: "1/2 cup" }] }],
  ["2024-07-31", ["2024-A2"], "Journal 2024.md", "Changed Hive 2 into a different box/bottom board and combined a new nuc into it to provide a queen.", { queenSeen: null }],
  ["2024-07-31", ["2024-D2-swarm"], "Journal 2024.md", "New swarm added at D2; queen presence was not yet confirmed.", { queenSeen: null }],
  ["2024-08-19", ["2024-D2-swarm"], "Journal 2024.md", "Doing well with lots of brood from the added swarm.", { queenSeen: true, broodPattern: "lots of brood" }],
  ["2024-08-19", ["2024-N3"], "Journal 2024.md", "N3 was dying and was being allowed to expire before equipment cleanup.", { queenSeen: false }],
  ["2025-03-02", ["2024-N4", "2024-B3", "2024-B4"], "Journal 2025.md", "Winter deadout confirmed.", { queenSeen: false }],
  ["2025-03-02", ["2024-A2"], "Journal 2025.md", "Very weak after winter; boosted with brood from A3. Possible laying worker despite seeing a queen.", { queenSeen: true, broodPattern: "possible laying-worker pattern" }],
  ["2025-03-02", ["2024-A3", "current-C4"], "Journal 2025.md", "Strong early-season colony.", { broodPattern: "strong brood buildup" }],
  ["2025-04-13", ["current-B2"], "Journal 2025.md", "Swarm colony had drawn its foundation but showed no eggs, so a queen cell was added.", { queenSeen: false, broodPattern: "no eggs" }],
  ["2025-04-28", ["2025-B3", "current-C1"], "Journal 2025.md", "New mated queen present and laying; colony still small.", { queenSeen: true, broodPattern: "eggs and larvae present" }],
  ["2025-04-28", ["current-C4"], "Journal 2025.md", "No eggs and many queen cells; divided into queen-cell nucs at C4 and D2.", { queenSeen: false, broodPattern: "no eggs; queen cells present" }],
  ["2025-05-13", ["2025-D2", "2025-B3", "current-C4"], "Journal 2025.md", "Small/new split improving; queens or fresh brood were present.", { queenSeen: true, broodPattern: "new brood" }],
  ["2025-06-11", ["2025-D2"], "Journal 2025.md", "Nuc was probably dead after being too small and leaving.", { queenSeen: false }],
  ["2025-06-25", ["2025-D2"], "Journal 2025.md", "Questionable queen: interspersed eggs/brood with all-drone brood; possible laying worker.", { queenSeen: null, broodPattern: "sporadic all-drone brood" }],
  ["2025-08-05", ["2024-A2"], "Journal 2025.md", "Queenless with many queen cells.", { queenSeen: false, broodPattern: "queen cells present" }],
  ["2025-08-22", ["2024-A2"], "Journal 2025.md", "New queen seen and starting to lay.", { queenSeen: true, broodPattern: "new eggs" }],
  ["2025-09-22", ["2024-A1"], "Journal 2025.md", "Queenless, with some brood and weak attempted queen cells remaining.", { queenSeen: false }],
  ["2025-09-22", ["2024-A3"], "Journal 2025.md", "Queenless with no brood or queen cells; dying and stacked/combined onto A1.", { queenSeen: false, broodPattern: "no brood" }],
  ["2026-02-18", ["2024-A1", "2024-A2", "2025-B3", "2024-C2"], "Journal 2026.md", "Winter deadout found during a quick check.", { queenSeen: false }],
  ["2026-03-01", ["2025-D4"], "Journal 2026.md", "Dead/queenless and moved/stacked onto D1 for cleanup.", { queenSeen: false }],
  ["2026-03-28", ["2024-B1"], "Journal 2026.md", "Queen gone or failing; paper-combined onto current B2.", { queenSeen: false }],
  ["2026-03-28", ["current-D1"], "Journal 2026.md", "The 2026-03-22 split was undone because the drone-heavy top had no queen cups.", { queenSeen: null }],
  ["2026-04-04", ["current-D2", "current-B3"], "Journal 2026.md", "Caught swarms hived at D2 and B3.", { queenSeen: null }],
  ["2026-04-12", ["2026-C2-sold"], "Journal 2026.md", "Successful top split from C4 moved to C2; eggs confirmed.", { queenSeen: true, broodPattern: "eggs present" }],
  ["2026-04-12", ["current-B1"], "Journal 2026.md", "Top of C1 moved to B1 and was strong enough for a honey super.", { queenSeen: true }],
  ["2026-04-12", ["2026-A1-sold"], "Journal 2026.md", "A4 top/queenless split moved to A3; no mated queen visible yet.", { queenSeen: false }],
  ["2026-04-19", ["current-C1"], "Journal 2026.md", "New mated queen confirmed, but laying only lightly.", { queenSeen: true, broodPattern: "small patch of eggs and brood" }],
  ["2026-04-19", ["2026-C2-sold"], "Journal 2026.md", "New mated queen confirmed laying; population remained small.", { queenSeen: true, broodPattern: "eggs present" }],
  ["2026-04-19", ["current-D2"], "Journal 2026.md", "Swarm nuc queen confirmed.", { queenSeen: true }],
  ["2026-04-25", ["current-C3"], "Journal 2026.md", "New mated queen confirmed with a good circular brood patch.", { queenSeen: true, broodPattern: "circle brood" }],
  ["2026-04-25", ["current-C1"], "Journal 2026.md", "Previously seen mated queen appeared to have failed; no brood remained and three new queen cups were started.", { queenSeen: false, broodPattern: "no brood; queen cups present" }],
  ["2026-04-25", ["current-D4"], "Journal 2026.md", "Old yellow 2022 queen likely failed; no eggs seen. Given two frames of very young brood from D3.", { queenSeen: false, broodPattern: "no eggs" }],
  ["2026-04-25", ["2026-A2-early"], "Journal 2026.md", "Likely laying worker with many eggs per cell; expected to fail.", { queenSeen: false, broodPattern: "multiple eggs per cell" }],
  ["2026-05-04", ["current-B2", "current-A4"], "Journal 2026.md", "Given right-age brood so the colony could raise a replacement queen.", { queenSeen: false, broodPattern: "brood frame added" }],
  ["2026-05-04", ["current-C4", "current-D4"], "Journal 2026.md", "New/superseding queen confirmed laying.", { queenSeen: true, broodPattern: "fresh eggs" }],
  ["2026-05-18", ["current-C1", "current-A4", "current-D1"], "Journal 2026.md", "New or superseding queen confirmed laying.", { queenSeen: true, broodPattern: "fresh brood" }],
  ["2026-07-14", ["current-B2"], "Journal 2026.md", "Queen spotted in the middle frames during honey-super staging.", { queenSeen: true }],
];

/**
 * Queen genealogy reconstructed from explicit grafts, queen-right moves,
 * queen-cell transfers, emergency brood donations, and later laying-queen
 * confirmations. A null parent means the notes do not identify the mother.
 * Approximate dates and inferred continuities are called out in each note.
 */
const queens = [
  {
    key: "q-2022-graft-donor",
    date: "2022-01-01",
    hiveKey: null,
    origin: "unknown",
    status: "missing",
    note: "Unassigned queen from the 'best hive from last year' used as the explicit larval donor for the March and April 2023 grafting rounds. Her exact hive identity and introduction date were not recorded.",
    sourceFile: "Queen Rearing 2023.md",
    sourceDetail: "2023-03-05 through 2023-04-04 graft donor",
  },
  {
    key: "q-2022-c3-yellow",
    date: "2022-01-01",
    hiveKey: "current-D4",
    origin: "unknown",
    status: "missing",
    note: "Yellow-marked queen identified in C3 as a 2022 queen. She moved with the queen-right C3 top to D4 on 2026-04-19 and likely failed by 2026-04-25. The date is year-level only.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-03-01 through 2026-04-25; yellow-marked 2022 queen",
  },
  {
    key: "q-2024-a1-root",
    date: "2024-07-16",
    hiveKey: "2024-A1",
    origin: "unknown",
    status: "dead",
    note: "A1 queen at the first numbered yard map. On 2025-04-21 the notes confirmed the original queen remained in A1 after its split. The colony died over winter by 2026-02-18; earlier ancestry cannot be assigned.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-21; original A1 queen remained",
  },
  {
    key: "q-2024-a2-root",
    date: "2024-07-31",
    hiveKey: "2024-A2",
    origin: "unknown",
    status: "superseded",
    note: "Queen established in A2 when a new nuc was combined into the broodless high-mite colony on 2024-07-31. The donor nuc was not identified. She became queenless or failed by 2025-08-05.",
    sourceFile: "Journal 2024.md",
    sourceDetail: "2024-07-31; unidentified nuc combined into A2",
  },
  {
    key: "q-2024-a3-root",
    date: "2024-07-16",
    hiveKey: "current-C2",
    origin: "unknown",
    status: "active",
    note: "Queen documented at A3 before the first traceable split. She moved queen-right with A3 top to D3 in 2025 and likely moved with D3 top to current C2 on 2026-05-18. The C2 transfer is strongly supported but was not visually confirmed that day.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-03-19 and 2025-04-17; queen-right A3 top to D3",
  },
  {
    key: "q-2024-a4-root",
    date: "2024-07-16",
    hiveKey: "2025-D4",
    origin: "unknown",
    status: "dead",
    note: "A4 queen at the first numbered yard map. She moved queen-right with A4 top to D4 in 2025. That colony was dead/queenless by 2026-03-01.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-03-19 and 2025-04-17; queen-right A4 top to D4",
  },
  {
    key: "q-2024-c2-root",
    date: "2024-07-16",
    hiveKey: "2024-C2",
    origin: "unknown",
    status: "dead",
    note: "C2 queen at the first numbered yard map. C2 likely swarmed on 2025-04-03; the bottom was believed to retain the queen while the top became B3. The C2 colony died over winter by 2026-02-18.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-03 and 2025-04-13; C2 swarm/split",
  },
  {
    key: "q-2025-b2-swarm",
    date: "2025-04-03",
    hiveKey: "current-B2",
    origin: "swarm",
    status: "missing",
    note: "Queen of the swarm caught 2025-04-03 and hived at B2. Eggs were present before an added queen cell hatched, confirming the swarm queen. B2 was queenless by 2026-05-04.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-03 through 2025-04-21; B2 swarm queen",
  },
  {
    key: "q-2025-c4-mother",
    date: "2024-07-16",
    hiveKey: "current-C4",
    origin: "unknown",
    status: "missing",
    note: "C4 queen predating the 2025 queen-cell events. Her eggs or queen cells produced the traceable 2025 C1, C4, and D2 daughters. C4 had no eggs and many queen cells by 2025-04-28, so her exact loss date is unknown.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-03 through 2025-04-28; C4 mother line",
  },
  {
    key: "q-2026-a1-swarm",
    date: "2026-04-27",
    hiveKey: "current-A1",
    origin: "swarm",
    status: "active",
    note: "Queen of the 2026-04-27 swarm. Two full frames of brood and eggs were present by 2026-05-04 after the swarm colony was combined with the failing early A2 bees.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-27 and 2026-05-04; current A1 swarm queen",
  },
  {
    key: "q-2026-a3-swarm",
    date: "2026-04-10",
    hiveKey: "current-A3",
    origin: "swarm",
    status: "active",
    note: "Queen of the successfully retained 2026-04-10 swarm, later moved to current A3. The source hive is unknown.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-10 retained swarm; current A3",
  },
  {
    key: "q-2026-b3-swarm",
    date: "2026-04-04",
    hiveKey: "current-B3",
    origin: "swarm",
    status: "active",
    note: "Queen of the larger swarm caught 2026-04-04 and hived at B3. Queen and eggs were repeatedly confirmed in April.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-04 through 2026-04-25; B3 swarm queen",
  },
  {
    key: "q-2026-d2-swarm",
    date: "2026-04-04",
    hiveKey: "current-D2",
    origin: "swarm",
    status: "active",
    note: "Queen of the 2026-04-04 swarm hived at D2. Initially uncertain, then confirmed laying on 2026-04-19 and 2026-04-25.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-04 through 2026-04-25; D2 swarm queen",
  },
  {
    key: "q-2026-a2-early",
    date: "2026-04-10",
    hiveKey: "2026-A2-early",
    origin: "unknown",
    status: "missing",
    note: "Queen in the early-season A2 nuc/swarm group. A mated queen was noted on 2026-04-19, but the colony showed laying-worker signs by 2026-04-25 and was combined into current A1 on 2026-05-04. Exact origin is not recorded.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-19 through 2026-05-04; failing early A2",
  },
  {
    key: "q-2023-graft-red",
    date: "2023-03-29",
    hiveKey: null,
    origin: "raised",
    parentQueenKey: "q-2022-graft-donor",
    status: "missing",
    note: "Only successfully mated queen from the first 2023 graft round; marked red. Her eventual colony was not recorded.",
    sourceFile: "Queen Rearing 2023.md",
    sourceDetail: "2023-03-29; first graft round",
  },
  {
    key: "q-2023-graft-two-a",
    date: "2023-04-27",
    hiveKey: null,
    origin: "raised",
    parentQueenKey: "q-2022-graft-donor",
    status: "missing",
    note: "One of two successfully mated queens from the second 2023 graft round. One daughter requeened combined weak colonies and the other returned to the grafting colony, but the notes do not distinguish which was which.",
    sourceFile: "Queen Rearing 2023.md",
    sourceDetail: "2023-04-27 through 2023-05-04; second graft round daughter A",
  },
  {
    key: "q-2023-graft-two-b",
    date: "2023-05-04",
    hiveKey: null,
    origin: "raised",
    parentQueenKey: "q-2022-graft-donor",
    status: "missing",
    note: "Second successfully mated daughter from the April 2023 graft round. Her assignment cannot be distinguished from the other successful daughter.",
    sourceFile: "Queen Rearing 2023.md",
    sourceDetail: "2023-05-04; second graft round daughter B",
  },
  {
    key: "q-2025-a2-replacement",
    date: "2025-08-22",
    hiveKey: "2024-A2",
    origin: "raised",
    originHiveKey: "2024-A2",
    parentQueenKey: "q-2024-a2-root",
    status: "dead",
    note: "Daughter raised from A2 queen cells after the prior queen failed. Confirmed starting to lay on 2025-08-22; the colony died over winter by 2026-02-18.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-08-05 and 2025-08-22; A2 replacement",
  },
  {
    key: "q-2025-a3-daughter",
    date: "2025-04-28",
    hiveKey: "2024-A3",
    origin: "raised",
    originHiveKey: "2024-A3",
    parentQueenKey: "q-2024-a3-root",
    status: "missing",
    note: "Daughter raised in A3 bottom from eggs left by the queen-right top. Confirmed laying on 2025-04-28; A3 was queenless by 2025-09-22 and was combined into A1.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-03-19 through 2025-04-28; A3 bottom daughter",
  },
  {
    key: "q-2025-a4-daughter",
    date: "2025-04-21",
    hiveKey: "current-A4",
    origin: "raised",
    originHiveKey: "current-A4",
    parentQueenKey: "q-2024-a4-root",
    status: "missing",
    note: "Daughter raised in A4 bottom after the original queen moved with the top to D4. Confirmed mated on 2025-04-21. She likely swarmed or failed during the 2026 A4 split sequence; exact disposition is unknown.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-03-19 through 2025-04-21; A4 bottom daughter",
  },
  {
    key: "q-2025-d1",
    date: "2025-05-05",
    hiveKey: "current-D1",
    origin: "raised",
    originHiveKey: "2024-A1",
    parentQueenKey: "q-2024-a1-root",
    status: "superseded",
    note: "Daughter raised by the A1 top split after the original queen was confirmed to have remained in A1. The split moved to D1 and the new queen was confirmed in May 2025. She was superseded by May 2026.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-21 through 2025-05-13; D1 daughter",
  },
  {
    key: "q-2025-b3",
    date: "2025-04-28",
    hiveKey: "2025-B3",
    origin: "raised",
    originHiveKey: "2024-C2",
    parentQueenKey: "q-2024-c2-root",
    status: "dead",
    note: "Queen raised in the C2 top/B3 split from C2 swarm cells. Eggs and larvae confirmed on 2025-04-28. The colony died over winter by 2026-02-18.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-03 through 2025-04-28; C2 top to B3",
  },
  {
    key: "q-2025-c1",
    date: "2025-04-28",
    hiveKey: "current-B1",
    origin: "raised",
    originHiveKey: "current-C4",
    parentQueenKey: "q-2025-c4-mother",
    status: "active",
    note: "Daughter raised in C1 from a C4 queen cell donated on 2025-04-13. Confirmed mated on 2025-04-28. She moved queen-right with C1 top to current B1 in April 2026.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-13 and 2025-04-28; C4 cell to C1",
  },
  {
    key: "q-2025-b4",
    date: "2025-04-13",
    hiveKey: "current-A2",
    origin: "raised",
    originHiveKey: "current-B4",
    status: "active",
    note: "Queen raised in B4 after the nuc received two C4 brood frames and the 'remaining' collected queen cell. The notes do not identify whether that cell came from A1, C2, or C4, so her mother is intentionally unknown. Confirmed strong by May 2025; moved queen-right with B4 top to current A2 on 2026-05-04.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-13 through 2025-05-05; B4 cell source uncertain",
  },
  {
    key: "q-2025-c4-bitchy",
    date: "2025-05-13",
    hiveKey: "current-C4",
    origin: "raised",
    originHiveKey: "current-C4",
    parentQueenKey: "q-2025-c4-mother",
    status: "superseded",
    note: "Daughter raised in the C4 half of the 2025-04-28 queen-cell split. Confirmed by sealed and developing brood on 2025-05-13. This is the repeatedly described defensive/bitchy C4 queen, superseded in spring 2026.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-28 through 2025-05-13; C4 daughter",
  },
  {
    key: "q-2025-d2",
    date: "2025-05-13",
    hiveKey: "2025-D2",
    origin: "raised",
    originHiveKey: "current-C4",
    parentQueenKey: "q-2025-c4-mother",
    status: "missing",
    note: "Probable daughter in the D2 half of the 2025-04-28 C4 queen-cell split. A queen and sparse eggs were reported in May, followed by drone-only/laying-worker signs. The exact queen fate is unknown.",
    sourceFile: "Journal 2025.md",
    sourceDetail: "2025-04-28 through 2025-08-22; C4 split to D2",
  },
  {
    key: "q-2026-a1-sold",
    date: "2026-04-19",
    hiveKey: "2026-A1-sold",
    origin: "raised",
    originHiveKey: "current-A4",
    parentQueenKey: "q-2025-a4-daughter",
    status: "active",
    note: "Daughter raised in the queenless A4 top split. She returned from mating to A4's honey super, was moved with her brood to A1, and was sold with the colony on 2026-04-25.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-03-22 through 2026-04-25; A4 daughter sold at A1",
  },
  {
    key: "q-2026-a4-current",
    date: "2026-05-18",
    hiveKey: "current-A4",
    origin: "emergency_cell",
    originHiveKey: "current-A4",
    status: "active",
    note: "Current A4 queen, raised after a fresh brood frame was added on 2026-05-04 and confirmed laying on 2026-05-18. The donor hive was not recorded, so her mother is intentionally left unknown.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-05-04 and 2026-05-18; A4 emergency queen",
  },
  {
    key: "q-2026-b2-current",
    date: "2026-07-14",
    hiveKey: "current-B2",
    origin: "emergency_cell",
    originHiveKey: "current-B2",
    status: "active",
    note: "Current B2 queen, raised from right-age brood added after B2 was found queenless on 2026-05-04. She was visually spotted on 2026-07-14. The brood donor was not recorded, so her mother is unknown.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-05-04 and 2026-07-14; B2 emergency queen",
  },
  {
    key: "q-2026-b4-current",
    date: "2026-06-14",
    hiveKey: "current-B4",
    origin: "emergency_cell",
    originHiveKey: "current-B4",
    status: "active",
    note: "Current B4 queen inferred after the original queen moved to A2 and B4 bottom received a fresh brood frame on 2026-05-04. No direct queen sighting is recorded, but the colony later remained strong and became a top 2026 producer. Date is approximate; brood donor and mother are unknown.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-05-04 through 2026-07-21; inferred B4 emergency queen",
  },
  {
    key: "q-2026-c1-first",
    date: "2026-04-19",
    hiveKey: "current-C1",
    origin: "raised",
    originHiveKey: "current-C1",
    parentQueenKey: "q-2025-c1",
    status: "missing",
    note: "First daughter raised by C1 bottom after the 2026 split. Confirmed laying lightly on 2026-04-19, then missing with no brood by 2026-04-25.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-03-15 through 2026-04-25; first C1 daughter",
  },
  {
    key: "q-2026-c2-sold",
    date: "2026-04-12",
    hiveKey: "2026-C2-sold",
    origin: "raised",
    originHiveKey: "current-C4",
    parentQueenKey: "q-2025-c4-bitchy",
    status: "active",
    note: "Daughter raised in the queenless C4 top split, moved to C2, and confirmed laying before the colony was sold on 2026-04-25.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-03-15 through 2026-04-25; C4 daughter sold at C2",
  },
  {
    key: "q-2026-c3-current",
    date: "2026-04-25",
    hiveKey: "current-C3",
    origin: "raised",
    originHiveKey: "current-C3",
    parentQueenKey: "q-2022-c3-yellow",
    status: "active",
    note: "Current C3 daughter, raised by C3 bottom after the old yellow queen moved with the top to D4. Confirmed with a strong circular brood patch on 2026-04-25.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-03-28 and 2026-04-25; C3 daughter",
  },
  {
    key: "q-2026-c4-current",
    date: "2026-05-04",
    hiveKey: "current-C4",
    origin: "raised",
    originHiveKey: "current-C4",
    parentQueenKey: "q-2025-c4-bitchy",
    status: "active",
    note: "Current C4 superseding daughter, probably raised from the prior queen's swarm cells. Confirmed laying eggs on 2026-05-04.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-05-04; C4 superseding daughter",
  },
  {
    key: "q-2026-d1-current",
    date: "2026-05-18",
    hiveKey: "current-D1",
    origin: "raised",
    originHiveKey: "current-D1",
    parentQueenKey: "q-2025-d1",
    status: "active",
    note: "Current D1 superseding daughter, confirmed by fresh larvae and royal jelly on 2026-05-18.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-05-18; D1 superseding daughter",
  },
  {
    key: "q-2026-d4-current",
    date: "2026-05-04",
    hiveKey: "current-D4",
    origin: "emergency_cell",
    originHiveKey: "current-D3",
    parentQueenKey: "q-2024-a3-root",
    status: "active",
    note: "Current D4 queen, raised from two frames of very young D3 brood added after the old yellow queen failed. Because the D3 queen is the continuing former A3 queen, this is her traceable daughter. Laying confirmed on 2026-05-04.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-25 and 2026-05-04; D3 brood to D4",
  },
  {
    key: "q-2026-d3-current",
    date: "2026-06-29",
    hiveKey: "current-D3",
    origin: "raised",
    originHiveKey: "current-D3",
    parentQueenKey: "q-2024-a3-root",
    status: "active",
    note: "Current D3 daughter inferred after the original D3 queen likely moved with the top to C2 on 2026-05-18. D3 remained strong through the June/July flows, supporting successful requeening. No direct queen sighting is recorded; date is the end of the journal's expected mating window.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-05-18 through 2026-07-21; inferred D3 daughter",
  },
  {
    key: "q-2026-c1-current",
    date: "2026-05-18",
    hiveKey: "current-C1",
    origin: "emergency_cell",
    originHiveKey: "current-C1",
    parentQueenKey: "q-2026-c1-first",
    status: "active",
    note: "Current C1 queen, raised from one of three queen cups started after the first 2026 daughter failed. Because those cups followed that queen's brief laying period, she is linked as the mother. Confirmed thriving and laying on 2026-05-18.",
    sourceFile: "Journal 2026.md",
    sourceDetail: "2026-04-25 and 2026-05-18; replacement C1 daughter",
  },
];

const fall2025Active = [
  "2024-A1", "2024-A2", "2024-A3", "current-A4",
  "2024-B1", "current-B2", "2025-B3", "current-B4",
  "current-C1", "2024-C2", "current-C3", "current-C4",
  "current-D1", "current-D3", "2025-D4",
];

const treatments = [
  ["2024-08-05", ["2024-A2"], "Journal 2024.md", "Oxalic acid vaporization, 8 g."],
  ["2024-08-05", ["2024-B1"], "Journal 2024.md", "Oxalic acid vaporization, 4 g."],
  ["2024-08-05", ["2024-N1", "2024-N2"], "Journal 2024.md", "Oxalic acid vaporization, 2 g per nuc side."],
  ["2024-08-05", ["2024-N4"], "Journal 2024.md", "Oxalic acid vaporization, 2 g."],
  ["2024-08-12", ["2024-A2"], "Journal 2024.md", "Oxalic acid vaporization follow-up, 4 g."],
  ["2025-09-06", fall2025Active, "Journal 2025.md", "Full-yard oxalic acid vaporization treatment."],
  ["2025-09-11", fall2025Active, "Journal 2025.md", "Full-yard oxalic acid vaporization treatment."],
  ["2025-09-17", fall2025Active, "Journal 2025.md", "Full-yard oxalic acid vaporization treatment; scheduled for 9/16 and completed 9/17."],
  ["2025-09-22", fall2025Active, "Journal 2025.md", "Final full-yard oxalic acid vaporization treatment in the fall series."],
];

const july2024Active = [
  "2024-A1", "2024-A2", "2024-A3", "current-A4",
  "2024-B1", "2024-N1", "2024-N2", "2024-B3", "2024-B4",
  "2024-N3", "2024-C2", "current-C3", "current-C4", "2024-N4",
  "2024-D2-swarm",
];

const winter2024Census = [
  "2024-A1", "2024-A2", "2024-A3", "current-A4",
  "2024-B1", "2024-B3", "2024-B4",
  "2024-C2", "current-C3", "current-C4", "2024-N4",
];

const feedings = [
  {
    date: "2024-07-31",
    keys: july2024Active,
    file: "Journal 2024.md",
    quantity: 17 / july2024Active.length,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Everyone was fed from 50 lbs sugar mixed to about 16-18 gal total. Stored as an approximate 17-gal allocation across the 15 identities known to be present.",
  },
  {
    date: "2024-08-19",
    keys: [
      "2024-A1", "2024-A2", "2024-A3", "current-A4", "2024-B1",
      "2024-B3", "2024-B4", "2024-C2", "current-C3", "current-C4",
      "2024-D2-swarm",
    ],
    file: "Journal 2024.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Full-size hives received 2 gal syrup.",
  },
  {
    date: "2024-08-19",
    keys: ["2024-N1", "2024-N2", "2024-N3", "2024-N4"],
    file: "Journal 2024.md",
    quantity: 1,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Nucs received 1 gal syrup.",
  },
  {
    date: "2024-09-16",
    keys: winter2024Census,
    file: "Journal 2024.md",
    quantity: 75 / winter2024Census.length,
    unit: "lbs",
    type: "dry_sugar",
    feederType: "other",
    note: "Fed 75 lbs sugar across the yard; stored as an approximate allocation across the 11-colony winter census.",
  },
  {
    date: "2024-10-04",
    keys: winter2024Census,
    file: "Journal 2024.md",
    quantity: 75 / winter2024Census.length,
    unit: "lbs",
    type: "dry_sugar",
    feederType: "other",
    note: "Fed another 75 lbs sugar across the yard; stored as an approximate allocation across the 11-colony winter census.",
  },
  {
    date: "2025-08-22",
    keys: fall2025Active,
    file: "Journal 2025.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "All 15 active hives received a 2 gal bucket from about 38 gal syrup / 90 lbs sugar.",
  },
  {
    date: "2025-09-22",
    keys: fall2025Active.filter((key) => key !== "2024-A3"),
    file: "Journal 2025.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Fourteen active colonies received 2 gal syrup; one prepared bucket was left after A3 went down.",
  },
];

const harvestSessions = [
  ["2023-wildflower", "2023-07-03", 203.5, "2023 wildflower harvest: 26 quarts + 96 pints, estimated 203.5 lbs."],
  ["2023-sourwood", "2023-08-10", 93.5, "2023 sourwood harvest: estimated 8-9 gal / 93.5 lbs."],
  ["2024-wildflower", "2024-06-16", 225.9, "2024 wildflower extraction: 225.9 lbs bucketed."],
  ["2024-sourwood", "2024-07-19", 88.945, "2024 sourwood extraction: 88.945 lbs bucketed."],
  ["2025-wildflower", "2025-06-17", 303.57, "2025 wildflower extraction: 303.57 lbs bucketed."],
  ["2025-sourwood", "2025-07-18", 255.81, "2025 sourwood extraction: 255.81 lbs bucketed."],
  ["2026-wildflower", "2026-07-19", 781.97, "2026 wildflower portion of the combined extraction run: 781.97 lbs bucketed from 22 supers."],
  ["2026-sourwood", "2026-07-19", 262.13, "2026 sourwood portion of the combined extraction run: 262.13 lbs bucketed from 11 green-taped supers."],
];

const measuredHarvests = [
  ["2025-wildflower", [
    ["2024-A1", 60.817], ["2024-A2", 51.815], ["2024-B1", 55.635],
    ["current-B2", 14.15], ["2024-C2", 44.12], ["current-C3", 61.51],
    ["current-D3", 10.1], ["2025-D4", 15.905],
  ]],
  ["2025-sourwood", [
    ["2024-A1", 50.87], ["2024-A2", 33.29], ["current-B2", 43.93],
    ["2024-C2", 33.07], ["current-C3", 37.88], ["current-D1", 13.8],
    ["current-D3", 23.75], ["2025-D4", 29.57],
  ]],
  ["2026-wildflower", [
    ["current-A2", 38.21], ["current-A3", 40.35], ["current-A4", 40.2],
    ["current-B1", 80.19], ["current-B2", 28.3], ["current-B3", 31.4],
    ["current-B4", 104.505], ["current-C1", 28.8], ["current-C3", 80.65],
    ["current-C4", 70.3], ["current-D1", 80.78], ["current-D3", 112.41],
    ["current-D4", 74.3],
  ]],
  ["2026-sourwood", [
    ["current-A1", 9.8], ["current-A3", 32.42], ["current-A4", 28.655],
    ["current-B1", 36.08], ["current-B3", 16.3], ["current-B4", 36.015],
    ["current-C1", 9.4], ["current-C3", 34.9], ["current-C4", 18.75],
    ["current-D2", 33.295], ["current-D4", 31.35],
  ]],
];

const inventreeSnapshot = "InvenTree database snapshot 2025-11-05";
const inventreeLiveSource = "InvenTree live database checked 2026-07-24";
const userInventoryConfirmation = "User inventory confirmation 2026-07-25";
const gnucashLiveSource = "GnuCash Web production database checked 2026-07-26";

/**
 * InvenTree build orders are the authoritative filling ledger from late 2024
 * through 2025. Quantities and completion dates come from completed build
 * allocations. Beez Trackz uses its catalog weights (22 oz/pint, 44 oz/quart)
 * when converting those known jar counts back to bulk pounds. Explicit
 * reconciliation movements preserve the user's confirmation that the remaining
 * packaged inventory is two 2025 wildflower quarts and one 2025 sourwood quart.
 * The full 2026 harvest remains unbottled in bulk.
 */
const jarMovements = [
  {
    date: "2023-07-03",
    kind: "jarring",
    amountLbs: 132,
    jarLabel: "Pint",
    quantity: 96,
    reason: "2023 wildflower filling",
    note: "The Honey Journal records 96 wildflower pints from the 2023 harvest.",
    sourceDetail: "2023 Wildflower Harvest; 96 pints",
  },
  {
    date: "2023-07-03",
    kind: "jarring",
    amountLbs: 71.5,
    jarLabel: "Quart",
    quantity: 26,
    reason: "2023 wildflower filling",
    note: "The Honey Journal records 26 wildflower quarts from the 2023 harvest.",
    sourceDetail: "2023 Wildflower Harvest; 26 quarts",
  },
  {
    date: "2023-12-31",
    kind: "bulk_use",
    amountLbs: 93.5,
    jarLabel: null,
    quantity: null,
    reason: "historical disposition reconciliation",
    note: "The full 2023 sourwood harvest is no longer on hand. Packaging and sale details were not recorded, so the remaining bulk is closed as sold or used.",
    sourceFile: userInventoryConfirmation,
    sourceDetail: "2023 sourwood; final on-hand quantity zero",
  },
  {
    date: "2024-11-26",
    kind: "jarring",
    amountLbs: 185.625,
    jarLabel: "Pint",
    quantity: 135,
    reason: "historical jarring",
    note: "InvenTree completed BO-0002 (96 pints) and BO-0004 (39 pints), for 135 pints total.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0002 + BO-0004",
  },
  {
    date: "2024-11-26",
    kind: "jarring",
    amountLbs: 99,
    jarLabel: "Quart",
    quantity: 36,
    reason: "historical jarring",
    note: "InvenTree completed BO-0001 (24 quarts) and BO-0003 (12 quarts), for 36 quarts total.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0001 + BO-0003",
  },
  {
    date: "2024-11-25",
    kind: "bulk_use",
    amountLbs: 7.5,
    jarLabel: null,
    quantity: null,
    reason: "bulk sale",
    note: "InvenTree shipment 2 allocated 7.5 lbs of bulk honey to SO-0004. The matching revenue is recorded as a sale without jar line items.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0004; shipment 2",
  },
  {
    date: "2024-12-31",
    kind: "bulk_use",
    amountLbs: 22.72,
    jarLabel: null,
    quantity: null,
    reason: "year-end inventory reconciliation",
    note: "Closes the unallocated 2024 bulk balance: 314.845 lbs harvested minus 284.625 lbs jarred and 7.5 lbs sold in bulk.",
    sourceFile: userInventoryConfirmation,
    sourceDetail: "2024 bulk; final on-hand quantity zero",
  },
  {
    date: "2025-06-17",
    kind: "bulk_use",
    amountLbs: 7.5,
    jarLabel: null,
    quantity: null,
    reason: "mead",
    note: "2025 wildflower harvest: 7.5 lbs set aside for mead.",
  },
  {
    date: "2025-07-25",
    kind: "jarring",
    amountLbs: 99,
    jarLabel: "Quart",
    quantity: 36,
    reason: "2025 wildflower filling",
    note: "InvenTree completed BO-0005: 36 wildflower quarts.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0005",
  },
  {
    date: "2025-07-25",
    kind: "jarring",
    amountLbs: 33,
    jarLabel: "Pint",
    quantity: 24,
    reason: "2025 wildflower filling",
    note: "InvenTree completed BO-0006: 24 wildflower pints.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0006",
  },
  {
    date: "2025-07-28",
    kind: "jarring",
    amountLbs: 33,
    jarLabel: "Pint",
    quantity: 24,
    reason: "2025 wildflower filling",
    note: "InvenTree completed BO-0007: 24 wildflower pints.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0007",
  },
  {
    date: "2025-07-28",
    kind: "jarring",
    amountLbs: 33,
    jarLabel: "Quart",
    quantity: 12,
    reason: "2025 wildflower filling",
    note: "InvenTree completed BO-0008: 12 wildflower quarts.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0008",
  },
  {
    date: "2025-08-02",
    kind: "jarring",
    amountLbs: 88,
    jarLabel: "Quart",
    quantity: 32,
    reason: "2025 wildflower filling",
    note: "InvenTree completed BO-0010: 32 wildflower quarts. Together the five wildflower builds reconcile to the Obsidian total of 80 quarts and 48 pints.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0010",
  },
  {
    date: "2025-09-02",
    kind: "jarring",
    amountLbs: 165,
    jarLabel: "Quart",
    quantity: 60,
    reason: "2025 sourwood filling",
    note: "InvenTree completed BO-0011: 60 sourwood quarts. The canceled BO-0009 produced zero jars and is intentionally excluded.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0011; BO-0009 excluded",
  },
  {
    date: "2025-09-02",
    kind: "jarring",
    amountLbs: 66,
    jarLabel: "Pint",
    quantity: 48,
    reason: "2025 sourwood filling",
    note: "InvenTree completed BO-0012: 48 sourwood pints.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0012",
  },
  {
    date: "2025-09-19",
    kind: "jarring",
    amountLbs: 19.25,
    jarLabel: "Quart",
    quantity: 7,
    reason: "2025 sourwood filling",
    note: "InvenTree completed BO-0013: 7 additional sourwood quarts.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "BO-0013",
  },
  {
    date: "2025-12-31",
    kind: "bulk_use",
    amountLbs: 15.63,
    jarLabel: null,
    quantity: null,
    reason: "year-end inventory reconciliation",
    note: "Closes the unallocated 2025 bulk balance: 559.38 lbs harvested minus 536.25 lbs jarred and 7.5 lbs used for mead. The three remaining 2025 quarts are already represented in the jar ledger.",
    sourceFile: userInventoryConfirmation,
    sourceDetail: "2025 bulk; final on-hand quantity zero",
  },
  {
    date: "2024-11-25",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 12,
    reason: "home consumption",
    note: "InvenTree SO-0005 shipped 12 quarts to Home Consumption.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0005; shipment 1",
  },
  {
    date: "2024-11-25",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 2,
    reason: "gift",
    note: "Two quarts in InvenTree SO-0003 were shipped at no charge.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0003; shipment 3",
  },
  {
    date: "2024-11-25",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 2,
    reason: "family gift",
    note: "InvenTree SO-0002 shipped two quarts to family at no charge.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0002; shipment 4",
  },
  {
    date: "2024-11-26",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Pint",
    quantity: 16,
    reason: "home consumption",
    note: "InvenTree SO-0008 shipped 16 pints to Home Consumption.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0008; shipment 7",
  },
  {
    date: "2025-07-24",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Pint",
    quantity: 1,
    reason: "replacement",
    note: "One no-charge replacement pint was shipped with InvenTree SO-0006.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0006; shipment 8",
  },
  {
    date: "2025-08-08",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 2,
    reason: "family gift",
    note: "InvenTree SO-0013 shipped two wildflower quarts to family at no charge.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0013; shipment 15",
  },
  {
    date: "2025-09-19",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 2,
    reason: "neighbor gift",
    note: "InvenTree SO-0011 shipped one wildflower quart and one sourwood quart at no charge.",
    sourceFile: inventreeSnapshot,
    sourceDetail: "SO-0011; shipment 12",
  },
  {
    date: "2025-12-02",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 2,
    reason: "family gift",
    note: "InvenTree SO-0019 shipped two wildflower quarts to family at no charge.",
    sourceFile: inventreeLiveSource,
    sourceDetail: "SO-0019; shipment 24",
  },
  {
    date: "2025-12-28",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Pint",
    quantity: 2,
    reason: "family gift",
    note: "InvenTree SO-0019 shipped one wildflower pint and one sourwood pint to family at no charge.",
    sourceFile: inventreeLiveSource,
    sourceDetail: "SO-0019; shipment 36",
  },
  {
    date: "2025-12-28",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 4,
    reason: "family gift",
    note: "InvenTree SO-0019 shipped two wildflower quarts and two sourwood quarts to family at no charge.",
    sourceFile: inventreeLiveSource,
    sourceDetail: "SO-0019; shipment 36",
  },
  {
    date: "2026-02-01",
    kind: "give_away",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 10,
    reason: "family gift",
    note: "InvenTree SO-0020 shipped eight wildflower quarts and two sourwood quarts to family at no charge.",
    sourceFile: inventreeLiveSource,
    sourceDetail: "SO-0020; shipment 44",
  },
  {
    date: "2023-07-02",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Pint",
    quantity: 46,
    reason: "GnuCash sales reconciliation",
    note: "Opening inventory offset for 46 paid pints sold before the first recorded 2023 harvest. The source harvest notes begin in July 2023.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "pre-2023-harvest paid sales; opening inventory",
  },
  {
    date: "2023-07-02",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 7,
    reason: "GnuCash sales reconciliation",
    note: "Opening inventory offset for seven paid quarts sold before the first recorded 2023 harvest.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "pre-2023-harvest paid sales; opening inventory",
  },
  {
    date: "2024-06-15",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Pint",
    quantity: -9,
    reason: "2023 sales reconciliation",
    note: "Closes 2023-vintage packaged inventory after 96 recorded pints, 87 GnuCash-correlated paid sales, and unitemized historical disposition.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "2023 vintage close; final on-hand quantity zero",
  },
  {
    date: "2024-06-15",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 2,
    reason: "2023 sales reconciliation",
    note: "Adds two net historical quarts required to reconcile 28 paid quart sales against 26 explicitly recorded 2023 wildflower quarts. The 2023 sourwood filling detail was not recorded.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "2023 vintage close; final on-hand quantity zero",
  },
  {
    date: "2025-07-31",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Pint",
    quantity: 3,
    reason: "2024 sales reconciliation",
    note: "Adds three net historical pints needed to reconcile 2024-vintage sales and documented give-aways against the InvenTree filling ledger.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "2024 vintage close; final on-hand quantity zero",
  },
  {
    date: "2025-07-31",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: 4,
    reason: "2024 sales reconciliation",
    note: "Adds four net historical quarts needed to reconcile 2024-vintage sales and documented give-aways against the InvenTree filling ledger.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "2024 vintage close; final on-hand quantity zero",
  },
  {
    date: "2026-07-26",
    kind: "jar_adjustment",
    amountLbs: null,
    jarLabel: "Quart",
    quantity: -43,
    reason: "2025 sales reconciliation",
    note: "Closes the disposed 2025 quart balance while preserving the final three quarts: two wildflower and one sourwood.",
    sourceFile: gnucashLiveSource,
    sourceDetail: "2025 vintage close; final on-hand quantity three",
  },
];

/**
 * The InvenTree shipment ledger is retained below as cross-reference evidence
 * for jar allocations and give-aways. GnuCash is authoritative for paid sales;
 * the correlated sale rows are built after this snapshot.
 */
const honeySales = [
  {
    orderRef: "SO-0004",
    shipmentRef: "2",
    date: "2024-11-25",
    customerName: "Generic Neighbors",
    location: "Neighbors",
    totalAmount: 50.025,
    lines: [],
    note: "Bulk sale: 7.5 lbs at $6.67/lb. The corresponding bulk-use movement deducts the honey.",
  },
  {
    orderRef: "SO-0003",
    shipmentRef: "3",
    date: "2024-11-25",
    customerName: "Generic Jung Tao",
    location: "Jung Tao",
    totalAmount: 780,
    lines: [
      { jarLabel: "Pint", quantity: 48, unitPrice: 10 },
      { jarLabel: "Quart", quantity: 15, unitPrice: 20 },
    ],
    note: "Paid allocations only; two additional no-charge quarts are recorded as a separate give-away movement.",
  },
  {
    orderRef: "SO-0001",
    shipmentRef: "5",
    date: "2024-11-25",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 310,
    lines: [{ jarLabel: "Pint", quantity: 31, unitPrice: 10 }],
    note: "Four paid InvenTree lines aggregate to 31 pints.",
  },
  {
    orderRef: "SO-0007",
    shipmentRef: "6",
    date: "2024-11-26",
    customerName: "Generic Jung Tao",
    location: "Jung Tao",
    totalAmount: 140,
    lines: [{ jarLabel: "Pint", quantity: 14, unitPrice: 10 }],
    note: "One paid shipment of 14 pints.",
  },
  {
    orderRef: "SO-0006",
    shipmentRef: "8",
    date: "2025-07-24",
    customerName: "Generic Jung Tao",
    location: "Jung Tao",
    totalAmount: 230,
    lines: [{ jarLabel: "Pint", quantity: 23, unitPrice: 10 }],
    note: "Paid allocations only; the no-charge replacement pint is recorded as a give-away movement.",
  },
  {
    orderRef: "SO-0009",
    shipmentRef: "10",
    date: "2025-07-24",
    customerName: "Home Consumption",
    location: "Home",
    totalAmount: 120,
    lines: [
      { jarLabel: "Pint", quantity: 2, unitPrice: 10 },
      { jarLabel: "Quart", quantity: 5, unitPrice: 20 },
    ],
    note: "InvenTree records this shipped order with paid line prices despite its Home Consumption customer category.",
  },
  {
    orderRef: "SO-0010",
    shipmentRef: "11",
    date: "2025-07-25",
    customerName: "Generic Jung Tao",
    location: "Jung Tao",
    totalAmount: 140,
    lines: [{ jarLabel: "Quart", quantity: 7, unitPrice: 20 }],
    note: "Seven wildflower quarts across three paid lines.",
  },
  {
    orderRef: "SO-0014",
    shipmentRef: "14",
    date: "2025-08-08",
    customerName: "Generic Coworkers",
    location: "Coworkers",
    totalAmount: 100,
    lines: [{ jarLabel: "Quart", quantity: 5, unitPrice: 20 }],
    note: "Five wildflower quarts.",
  },
  {
    orderRef: "SO-0015",
    shipmentRef: "16",
    date: "2025-09-02",
    customerName: "Generic Friends",
    location: "Friends",
    totalAmount: 100,
    lines: [{ jarLabel: "Quart", quantity: 4, unitPrice: 25 }],
    note: "Shipment 16 contained two wildflower and two sourwood quarts. The order header remained open, but these stock allocations were shipped.",
  },
  {
    orderRef: "SO-0011",
    shipmentRef: "12",
    date: "2025-09-19",
    customerName: "Generic Neighbors",
    location: "Neighbors",
    totalAmount: 40,
    lines: [{ jarLabel: "Quart", quantity: 2, unitPrice: 20 }],
    note: "Paid wildflower allocations only; one wildflower and one sourwood gift quart are recorded separately. The order header remained open, but the allocations were shipped.",
  },
  {
    orderRef: "SO-0015",
    shipmentRef: "17",
    date: "2025-09-19",
    customerName: "Generic Friends",
    location: "Friends",
    totalAmount: 50,
    lines: [{ jarLabel: "Quart", quantity: 2, unitPrice: 25 }],
    note: "Second shipment for SO-0015: two sourwood quarts.",
  },
  {
    orderRef: "SO-0011",
    shipmentRef: "20",
    date: "2025-11-13",
    customerName: "Generic Neighbors",
    location: "Neighbors",
    totalAmount: 120,
    lines: [{ jarLabel: "Pint", quantity: 12, unitPrice: 10 }],
    note: "Six wildflower pints and six sourwood pints.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "22",
    date: "2025-11-13",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 792.5,
    lines: [
      { jarLabel: "Pint", quantity: 6, unitPrice: 10.833333 },
      { jarLabel: "Pint", quantity: 14, unitPrice: 11.7857 },
      { jarLabel: "Pint", quantity: 7, unitPrice: 12.5 },
      { jarLabel: "Quart", quantity: 12, unitPrice: 22.916667 },
      { jarLabel: "Quart", quantity: 8, unitPrice: 25 },
    ],
    note: "Twenty-seven pints and twenty quarts. InvenTree's fractional unit prices allocate whole-order totals across several marketplace lines; the rounded shipment total is $792.50.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0015",
    shipmentRef: "21",
    date: "2025-11-17",
    customerName: "Generic Friends",
    location: "Friends",
    totalAmount: 25,
    lines: [{ jarLabel: "Quart", quantity: 1, unitPrice: 25 }],
    note: "One sourwood quart.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "23",
    date: "2025-11-17",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 275.04,
    lines: [{ jarLabel: "Quart", quantity: 12, unitPrice: 22.92 }],
    note: "Twelve sourwood quarts.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0017",
    shipmentRef: "18",
    date: "2025-12-02",
    customerName: "Carolina Pedal Works Sales",
    location: "Carolina Pedal Works",
    totalAmount: 50,
    lines: [
      { jarLabel: "Pint", quantity: 2, unitPrice: 12.5 },
      { jarLabel: "Quart", quantity: 1, unitPrice: 25 },
    ],
    note: "One wildflower pint, one sourwood pint, and one sourwood quart.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "26",
    date: "2025-12-02",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 100,
    lines: [{ jarLabel: "Quart", quantity: 4, unitPrice: 25 }],
    note: "Two wildflower quarts and two sourwood quarts.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "28",
    date: "2025-12-11",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 50,
    lines: [{ jarLabel: "Quart", quantity: 2, unitPrice: 25 }],
    note: "Two sourwood quarts.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "29",
    date: "2025-12-11",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 37.5,
    lines: [{ jarLabel: "Pint", quantity: 3, unitPrice: 12.5 }],
    note: "Three sourwood pints.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0015",
    shipmentRef: "25",
    date: "2025-12-12",
    customerName: "Generic Friends",
    location: "Friends",
    totalAmount: 75,
    lines: [{ jarLabel: "Quart", quantity: 3, unitPrice: 25 }],
    note: "One wildflower quart and two sourwood quarts.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "31",
    date: "2025-12-19",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 25,
    lines: [{ jarLabel: "Quart", quantity: 1, unitPrice: 25 }],
    note: "One wildflower quart.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0015",
    shipmentRef: "30",
    date: "2025-12-28",
    customerName: "Generic Friends",
    location: "Friends",
    totalAmount: 70,
    lines: [{ jarLabel: "Pint", quantity: 7, unitPrice: 10 }],
    note: "Seven wildflower pints.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "32",
    date: "2025-12-28",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 250,
    lines: [
      { jarLabel: "Pint", quantity: 5, unitPrice: 25 },
      { jarLabel: "Quart", quantity: 5, unitPrice: 25 },
    ],
    note: "InvenTree records five sourwood pints and five wildflower quarts at $25 each. The unusual pint price is retained exactly as entered for auditability.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "33",
    date: "2025-12-29",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 100,
    lines: [{ jarLabel: "Pint", quantity: 8, unitPrice: 12.5 }],
    note: "Eight wildflower pints.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "34",
    date: "2026-01-02",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 50,
    lines: [{ jarLabel: "Quart", quantity: 2, unitPrice: 25 }],
    note: "Two wildflower quarts.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "35",
    date: "2026-01-04",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 50,
    lines: [{ jarLabel: "Quart", quantity: 2, unitPrice: 25 }],
    note: "Two wildflower quarts.",
    sourceFile: inventreeLiveSource,
  },
  {
    orderRef: "SO-0018",
    shipmentRef: "37",
    date: "2026-01-05",
    customerName: "Generic Facebook Marketplace",
    location: "Facebook Marketplace",
    totalAmount: 12.5,
    lines: [{ jarLabel: "Pint", quantity: 1, unitPrice: 12.5 }],
    note: "One sourwood pint.",
    sourceFile: inventreeLiveSource,
  },
];

/**
 * Paid honey transactions from Income:Farm:Beekeeping in gnucash-web-prod.
 * Tuple fields are [date, GnuCash transaction GUID, revenue, pints, quarts].
 * Gifts, a hay transaction, and a hive sale are deliberately excluded.
 * Descriptions containing personal names remain only in GnuCash.
 */
const gnucashSaleRows = [
  ["2022-09-11", "ae5d2e2d6901411ebdd0a192bc136f88", 120.00, 12, 0],
  ["2022-09-11", "cfe36a9f54a1426fad54c393892e5787", 40.00, 4, 0],
  ["2022-09-25", "dffb470f417d4bb494a01af6f0a97cbf", 60.00, 2, 2],
  ["2022-10-09", "efdb845c4bd94605afa2047befdd8e02", 24.00, 2, 0],
  ["2022-11-25", "17f449a5e9ff46a6a6a76352986cd8df", 10.00, 1, 0],
  ["2023-01-13", "90b73234a7a047779c988c67d1ab7f27", 10.00, 1, 0],
  ["2023-01-13", "e62784ffedcc476698debae33750cde9", 20.00, 0, 1],
  ["2023-02-11", "66bbddde738c42cab4513407fa8f6930", 20.00, 2, 0],
  ["2023-02-16", "53b144c946684f9085ad4f7f292cf2f7", 20.00, 0, 1],
  ["2023-03-06", "03ea0311b69343aba667a009dc5e4af0", 10.00, 1, 0],
  ["2023-03-27", "132c9dc415fc4fd190d6cb560b36cfb8", 20.00, 2, 0],
  ["2023-03-28", "8d739008a0d645f2a78426c82ca5506c", 120.00, 12, 0],
  ["2023-04-13", "44ff70ea0cb04dda9a92098eaae414ec", 10.00, 1, 0],
  ["2023-04-17", "75f02b6bb17d44f8bbfdacf61d990b50", 40.00, 2, 1],
  ["2023-04-30", "baf80fdb84044cff8b786f423bc52f50", 10.00, 1, 0],
  ["2023-05-14", "1ee5b0132e7c4fb6a198f4f141d98edb", 10.00, 1, 0],
  ["2023-05-15", "6e80096121144e43bbff1674e991f1da", 40.00, 2, 1],
  ["2023-06-11", "3a73e3690ea44815a4780ffa718486f6", 20.00, 0, 1],
  ["2023-08-09", "7503e16e6f174387bd1272dde00cd42f", 40.00, 0, 2],
  ["2023-08-13", "15a302fa14ac4184b0bfbd00882bc89b", 60.00, 2, 2],
  ["2023-08-17", "7c393f450faf4e83b0d77ef6584a9fb6", 100.00, 0, 5],
  ["2023-08-18", "3d12d854ef1646f5b412f8cdcce080b5", 20.00, 0, 1],
  ["2023-08-19", "61cf1321702144169c62c04e66d3ab7b", 20.00, 0, 1],
  ["2023-08-20", "46d2363852bd4549b784e182b25df40d", 20.00, 0, 1],
  ["2023-08-20", "742cb8605a064096b8c119a3cf92f339", 20.00, 2, 0],
  ["2023-08-20", "82eb14ba0c51413aa72979d7d0b16c86", 20.00, 0, 1],
  ["2023-08-20", "dac129dec33a4df7b55c2f9a5233a943", 10.00, 1, 0],
  ["2023-08-23", "abee4b477c3043d2a042a45f374c0420", 140.00, 0, 7],
  ["2023-09-14", "bf5c32e58d1d4e82ab0d4a86fad574a5", 20.00, 0, 1],
  ["2023-09-18", "99214678c471481ca0b13fe7b7c11697", 40.00, 0, 2],
  ["2023-09-22", "333871280da54ec9b862a0b559aade94", 20.00, 2, 0],
  ["2023-09-23", "b8002b60ec8146fe8b9a7b027944ebd4", 20.00, 2, 0],
  ["2023-09-23", "cb4a2353ed324051bfe18d914aaac63e", 40.00, 0, 2],
  ["2023-10-06", "54f8d6c57f0945bf9fe415831243b264", 120.00, 12, 0],
  ["2023-10-08", "f7cd01ac47e14f24bf458b6e54f7e861", 30.00, 3, 0],
  ["2023-10-21", "43264668411046c682e353d51ce66193", 60.00, 0, 3],
  ["2023-10-21", "adbc81bc9d634f0c8fcd068cd53d3b42", 20.00, 2, 0],
  ["2023-10-25", "12132032c7cd44fd8d131d52222ffe45", 20.00, 2, 0],
  ["2023-11-04", "ff980b8be4604f1d9808fa68354d16cc", 120.00, 12, 0],
  ["2023-11-08", "6a4a249a0c7f48369c66ceb3210f29eb", 100.00, 10, 0],
  ["2023-11-19", "3e2f33b34faf49e596f8464e28db3d5a", 10.00, 1, 0],
  ["2023-11-19", "796264d2962e4662917eee0b2c5e2478", 40.00, 4, 0],
  ["2023-11-19", "82f2058df4af466cb5d8fdf3e528bb1d", 10.00, 1, 0],
  ["2023-11-19", "b6a51cf8ee5b45eaa520b02f7cb9afa4", 40.00, 4, 0],
  ["2023-12-05", "40c75369982647159de964d2df833233", 40.00, 4, 0],
  ["2023-12-07", "3c9c468df587488dbcf4659df1780fb2", 60.00, 6, 0],
  ["2023-12-13", "e2a6794030e34faf98e63cecb1667209", 40.00, 4, 0],
  ["2023-12-15", "7db7d65dbfbe43c3aa826abc79666ec0", 100.00, 10, 0],
  ["2023-12-17", "9816a8dd26b14f03acee5bda2815901f", 10.00, 1, 0],
  ["2024-05-12", "83802caf22384078969f80f5e648c2c4", 20.00, 2, 0],
  ["2024-06-30", "60db0a7e1edb4427a4e7c12a60232376", 160.00, 14, 1],
  ["2024-07-08", "30774a2c6cc142dc8db01f7eedf2ad7b", 130.00, 13, 0],
  ["2024-07-17", "d31730925a9848c48fd96bd2aa6447fe", 20.00, 0, 1],
  ["2024-07-19", "f46eef3904f449b098b2c7caf90e0e0d", 20.00, 0, 1],
  ["2024-07-20", "8ea2055ca9634cb7aace48819bc4d8c2", 100.00, 0, 5],
  ["2024-08-18", "2a1ba1f7e6d141bdafb9df6ea209bb15", 50.00, 5, 0],
  ["2024-08-19", "1f68bfc1e90b446682f1dc16ed6b1d3b", 40.00, 0, 2],
  ["2024-09-17", "0a2204108eb84767a1459c996eb0b439", 40.00, 0, 2],
  ["2024-09-17", "c3877b1c274f4a3da7ea2bbb83c13eb5", 40.00, 0, 2],
  ["2024-09-26", "8949f92f29744cba9a27b2082ee2075a", 22.00, 0, 1],
  ["2024-11-11", "b0b0959831614ffd96a152202e6a442d", 40.00, 4, 0],
  ["2024-11-24", "30f946e11fb94b578418ff1b36662c76", 110.00, 11, 0],
  ["2024-11-24", "4f06482477f0417e9766c9a1154f711a", 40.00, 4, 0],
  ["2024-11-24", "fbaa5f2ce0cc46ecac3afc2ee08787f6", 40.00, 4, 0],
  ["2024-11-25", "516f84556a864cce9224e24fac5d634a", 170.00, 17, 0],
  ["2024-11-25", "e3849510e71f4a8fa7d6d1ad09996d72", 120.00, 12, 0],
  ["2024-11-26", "db1ec1abc2454e5fbc8170ff53f6873d", 140.00, 14, 0],
  ["2024-11-29", "b7684772ade84bceaf6202af307d87d6", 80.00, 4, 2],
  ["2024-12-03", "28e4a57def4542ac85c579f4b3db4a90", 190.00, 19, 0],
  ["2025-07-20", "19d3bf1384784d25a36ec12a4a64d452", 40.00, 0, 2],
  ["2025-07-20", "c0b0f73a390e4f7f9348a4856fd8352e", 40.00, 0, 2],
  ["2025-07-21", "63c0cc83c45c4e7094a6ef71df7a0ce9", 20.00, 0, 1],
  ["2025-07-29", "0c6d48b9b18d4fdd9fab9f23fc513989", 20.00, 0, 1],
  ["2025-07-29", "97c3170dc20d4ef18d56c4124b5ba99c", 20.00, 0, 1],
  ["2025-08-24", "573c08e9a98e42f4bee9dd7a3aa10681", 100.00, 0, 4],
  ["2025-09-09", "139e914a46f84999b421b24e139ce87b", 25.00, 0, 1],
  ["2025-09-18", "786845b99d9f4c228f57df6292cbcf8b", 25.00, 0, 1],
  ["2025-10-15", "d1ba8afc647c428aa2588d72f341eff0", 140.00, 12, 0],
  ["2025-10-20", "8d2be71d0f054c51a6c344e4c548e36c", 165.00, 14, 0],
  ["2025-10-23", "dc28ec36563b4d82b0afd9b4d75615ec", 275.00, 0, 12],
  ["2025-10-24", "3ad986c4ac1c4233b34dec9888bcbfed", 50.00, 0, 2],
  ["2025-10-24", "8894eec7ffd445c2b1974f16281f973d", 37.50, 1, 1],
  ["2025-10-25", "779f42bc3b8e4ff3b98b00c98e4833c4", 120.00, 12, 0],
  ["2025-10-26", "4f48bdeb679d4a8e9918ed6e36cc5714", 50.00, 0, 2],
  ["2025-11-05", "3713fea8dd3946a28ba2218d5a6f8ea6", 25.00, 0, 1],
  ["2025-11-07", "a9813d3f32124f1c93feb5b32adc90ea", 50.00, 0, 2],
  ["2025-11-10", "58c95b0ba546466abe43d733aa66ead5", 25.00, 0, 1],
  ["2025-11-10", "d1707e236d47468d9614e79ca697ccb1", 25.00, 0, 1],
  ["2025-11-10", "d92b77f5a5fc400d8e0d497f397524ce", 25.00, 2, 0],
  ["2025-11-17", "5b9232330cf947c5a4685ad976ef20da", 275.00, 0, 12],
  ["2025-12-01", "cafd3879f38e492b995f6aa67f9fea26", 100.00, 0, 4],
  ["2025-12-10", "574bb361dd634f80b1b2550ef512ef3f", 50.00, 0, 2],
  ["2025-12-11", "52a1bf08eb65495ba4a765fd3f0ba4f6", 37.50, 3, 0],
  ["2025-12-11", "68d6e9b54b0e406799012cac013b2b36", 70.00, 7, 0],
  ["2025-12-12", "29de692ae8c74132999dfb37ec223791", 75.00, 0, 3],
  ["2025-12-19", "089bd5bfd60e4e0f88ce83b4c3759a5c", 25.00, 0, 1],
  ["2025-12-28", "541496d0a3c943d1afe02fb050803ad5", 250.00, 10, 0],
  ["2025-12-29", "9dc649a0094d4d1490c50a667c974414", 100.00, 8, 0],
  ["2026-01-02", "e82d083652ce4850962524909d8b183d", 50.00, 0, 2],
  ["2026-01-04", "162b86ce5fa840ea8fdf849e12148f32", 50.00, 0, 2],
  ["2026-01-05", "12a20581016b468384633c5211aef73b", 12.50, 1, 0],
  ["2026-02-04", "e79b85153dde4d90b75159c86dad1021", 25.00, 0, 1],
  ["2026-02-16", "a64ba19a62ce4aada7ed6a25c3b3dcfb", 100.00, 0, 4],
  ["2026-03-12", "8a53a3d6a76a4e73a54e491a7a80603d", 50.00, 2, 1],
  ["2026-03-13", "1bdf75e52e194d23b79d53d96dd625b3", 725.00, 22, 18],
  ["2026-04-18", "ae49374d55f348c1b10f8e1ede7f6055", 75.00, 0, 3],
];

const gnucashSaleNotes = new Map([
  [
    "541496d0a3c943d1afe02fb050803ad5",
    "Ten sourwood pints sold at the confirmed premium price of $25 per pint.",
  ],
  [
    "8a53a3d6a76a4e73a54e491a7a80603d",
    "First CPW inventory sale: one quart and two pints, totaling $50.",
  ],
  [
    "1bdf75e52e194d23b79d53d96dd625b3",
    "CPW inventory drawdown: 18 quarts and 22 pints sold for $725. Together with the prior one-quart/two-pint sale, this leaves five quarts from the original 24-quart/24-pint stock.",
  ],
]);

function correlatedGnuCashSale([date, guid, totalAmount, pints, quarts]) {
  const quartPrice = date >= "2025-08-01" ? 25 : 20;
  const pintPrice = quartPrice / 2;
  const standardTotal = pints * pintPrice + quarts * quartPrice;
  const priceFactor = totalAmount / standardTotal;
  const lines = [];
  if (pints) {
    lines.push({ jarLabel: "Pint", quantity: pints, unitPrice: pintPrice * priceFactor });
  }
  if (quarts) {
    lines.push({ jarLabel: "Quart", quantity: quarts, unitPrice: quartPrice * priceFactor });
  }

  const isStandardPrice = Math.abs(priceFactor - 1) <= 0.000001;
  return {
    sourceKey: guid,
    date,
    customerName: "GnuCash honey sale",
    location: "GnuCash",
    totalAmount,
    lines,
    note: gnucashSaleNotes.get(guid) || (isStandardPrice
      ? `Paid honey sale at the expected ${quartPrice === 25 ? "2025-harvest" : "2024-or-earlier"} price.`
      : "Paid honey sale; the GnuCash total is authoritative and is allocated proportionally across the described jar quantities."),
    sourceFile: gnucashLiveSource,
    sourceDetail: `transaction ${guid}; Income:Farm:Beekeeping`,
  };
}

const correlatedHoneySales = gnucashSaleRows.map(correlatedGnuCashSale);

function validateManifest() {
  const keys = new Set();
  const identityByKey = new Map();
  const currentSeen = new Set();

  for (const identity of identities) {
    if (keys.has(identity.key)) throw new Error(`Duplicate identity key: ${identity.key}`);
    keys.add(identity.key);
    identityByKey.set(identity.key, identity);

    if (!identity.locations?.length) {
      throw new Error(`Identity ${identity.key} has no location history`);
    }

    if (new Date(identity.locations[0][0]).getTime() !== new Date(identity.installed).getTime()) {
      throw new Error(`Identity ${identity.key} installed date does not match its first location`);
    }
    for (let index = 0; index < identity.locations.length; index++) {
      const [from, to] = identity.locations[index];
      if (to && new Date(from) >= new Date(to)) {
        throw new Error(`Identity ${identity.key} has a non-positive location interval at ${from}`);
      }
      const next = identity.locations[index + 1];
      if (next && to !== next[0]) {
        throw new Error(`Identity ${identity.key} has a location gap/overlap between ${to} and ${next[0]}`);
      }
    }

    const open = identity.locations.filter(([, to]) => to == null);
    if (identity.currentLabel) {
      if (currentSeen.has(identity.currentLabel)) {
        throw new Error(`Duplicate current position: ${identity.currentLabel}`);
      }
      currentSeen.add(identity.currentLabel);
      if (open.length !== 1 || open[0][2] !== identity.currentLabel) {
        throw new Error(`Current identity ${identity.key} must have one open location matching ${identity.currentLabel}`);
      }
    } else if (open.length !== 0) {
      throw new Error(`Historical identity ${identity.key} has an open location`);
    } else if (identity.ended !== identity.locations.at(-1)[1]) {
      throw new Error(`Historical identity ${identity.key} ended date does not match its last location`);
    }
  }

  for (const label of currentLabels) {
    if (!currentSeen.has(label)) throw new Error(`Missing current identity for ${label}`);
  }
  if (currentSeen.size !== currentLabels.length) {
    throw new Error(`Expected ${currentLabels.length} current identities; found ${currentSeen.size}`);
  }

  for (const [, parent, child] of splits) {
    if (!identityByKey.has(parent)) throw new Error(`Unknown split parent: ${parent}`);
    if (!identityByKey.has(child)) throw new Error(`Unknown split child: ${child}`);
    if (parent === child) throw new Error(`Split cannot reference one identity twice: ${parent}`);
  }
  for (const [, eventKeys] of inspections) {
    for (const key of eventKeys) {
      if (!identityByKey.has(key)) throw new Error(`Unknown inspection identity: ${key}`);
    }
  }
  for (const [, eventKeys] of treatments) {
    for (const key of eventKeys) {
      if (!identityByKey.has(key)) throw new Error(`Unknown treatment identity: ${key}`);
    }
  }
  for (const feeding of feedings) {
    for (const key of feeding.keys) {
      if (!identityByKey.has(key)) throw new Error(`Unknown feeding identity: ${key}`);
    }
  }
  const queenByKey = new Map();
  const queenIndexByKey = new Map();
  const validQueenOrigins = new Set(["purchased", "swarm", "raised", "walked", "emergency_cell", "unknown"]);
  const validQueenStatuses = new Set(["active", "superseded", "dead", "missing"]);
  for (const [index, queen] of queens.entries()) {
    if (!queen.key || queenByKey.has(queen.key)) {
      throw new Error(`Duplicate or missing queen key: ${queen.key}`);
    }
    queenByKey.set(queen.key, queen);
    queenIndexByKey.set(queen.key, index);
    if (queen.hiveKey && !identityByKey.has(queen.hiveKey)) {
      throw new Error(`Unknown hive ${queen.hiveKey} for queen ${queen.key}`);
    }
    if (queen.originHiveKey && !identityByKey.has(queen.originHiveKey)) {
      throw new Error(`Unknown origin hive ${queen.originHiveKey} for queen ${queen.key}`);
    }
    if (!validQueenOrigins.has(queen.origin)) {
      throw new Error(`Invalid origin ${queen.origin} for queen ${queen.key}`);
    }
    if (!validQueenStatuses.has(queen.status)) {
      throw new Error(`Invalid status ${queen.status} for queen ${queen.key}`);
    }
  }
  for (const queen of queens) {
    if (!queen.parentQueenKey) continue;
    const parent = queenByKey.get(queen.parentQueenKey);
    if (!parent) {
      throw new Error(`Unknown parent queen ${queen.parentQueenKey} for ${queen.key}`);
    }
    if (queenIndexByKey.get(queen.parentQueenKey) >= queenIndexByKey.get(queen.key)) {
      throw new Error(`Parent queen ${queen.parentQueenKey} must precede daughter ${queen.key}`);
    }
    if (new Date(parent.date) > new Date(queen.date)) {
      throw new Error(`Parent queen ${queen.parentQueenKey} is dated after daughter ${queen.key}`);
    }
  }
  for (const identity of identities.filter((entry) => entry.currentLabel)) {
    const activeQueens = queens.filter(
      (queen) => queen.hiveKey === identity.key && queen.status === "active",
    );
    if (activeQueens.length !== 1) {
      throw new Error(
        `Expected one active queen for current ${identity.currentLabel}; found ${activeQueens.length}`,
      );
    }
  }
  const sessionKeys = new Set(harvestSessions.map(([key]) => key));
  for (const [sessionKey, rows] of measuredHarvests) {
    if (!sessionKeys.has(sessionKey)) throw new Error(`Unknown measured harvest session: ${sessionKey}`);
    for (const [key] of rows) {
      if (!identityByKey.has(key)) throw new Error(`Unknown harvest identity: ${key}`);
    }
  }

  for (const movement of jarMovements) {
    if (movement.kind === "jarring" || movement.kind === "give_away") {
      if (!movement.jarLabel || !Number.isInteger(movement.quantity) || movement.quantity <= 0) {
        throw new Error(`Invalid ${movement.kind} movement on ${movement.date}`);
      }
    }
    if (movement.kind === "jar_adjustment") {
      if (!movement.jarLabel || !Number.isInteger(movement.quantity) || movement.quantity === 0) {
        throw new Error(`Invalid jar-adjustment movement on ${movement.date}`);
      }
    }
    if (movement.kind === "bulk_use" && !(movement.amountLbs > 0)) {
      throw new Error(`Invalid bulk-use movement on ${movement.date}`);
    }
  }

  if (honeySales.length !== 27) {
    throw new Error(`Expected 27 InvenTree cross-reference shipments; found ${honeySales.length}`);
  }
  if (correlatedHoneySales.length !== 106) {
    throw new Error(`Expected 106 paid GnuCash honey transactions; found ${correlatedHoneySales.length}`);
  }
  const gnucashTotals = gnucashSaleRows.reduce(
    (totals, [, , amount, pints, quarts]) => ({
      revenue: totals.revenue + amount,
      pints: totals.pints + pints,
      quarts: totals.quarts + quarts,
    }),
    { revenue: 0, pints: 0, quarts: 0 },
  );
  if (
    Math.abs(gnucashTotals.revenue - 6933.5) > 0.001
    || gnucashTotals.pints !== 348
    || gnucashTotals.quarts !== 140
  ) {
    throw new Error(`Unexpected GnuCash totals: ${JSON.stringify(gnucashTotals)}`);
  }

  const saleKeys = new Set();
  for (const sale of correlatedHoneySales) {
    const key = sale.sourceKey;
    if (saleKeys.has(key)) throw new Error(`Duplicate GnuCash sale transaction: ${key}`);
    saleKeys.add(key);
    if (!(sale.totalAmount > 0)) throw new Error(`Invalid sale total for ${key}`);
    const lineTotal = sale.lines.reduce((total, line) => {
      if (!line.jarLabel || !Number.isInteger(line.quantity) || line.quantity <= 0 || line.unitPrice < 0) {
        throw new Error(`Invalid sale line for ${key}`);
      }
      return total + line.quantity * line.unitPrice;
    }, 0);
    if (sale.lines.length && Math.abs(lineTotal - sale.totalAmount) > 0.001) {
      throw new Error(`Sale lines do not reconcile for ${key}: ${lineTotal} != ${sale.totalAmount}`);
    }
  }
}

function cleanupSql() {
  const noteClause = previousImportTags
    .map((tag) => `notes like ${q(`%[Obsidian import:${tag}%`)}`)
    .join(" or ");
  const mediaClause = previousImportTags
    .map((tag) => `source_media @> ${q(JSON.stringify({ import: tag }))}::jsonb`)
    .join(" or ");

  return [
    `delete from honey_sale_items where sale_id in (select id from honey_sales where ${noteClause});`,
    `delete from honey_sales where ${noteClause};`,
    `delete from honey_movements where ${noteClause};`,
    `delete from honey_harvests where ${noteClause}
      or session_id in (select id from harvest_sessions where ${noteClause});`,
    `delete from harvest_sessions where ${noteClause};`,
    `delete from feedings where ${noteClause};`,
    `delete from hive_splits where ${noteClause};`,
    `delete from queens where ${noteClause};`,
    `delete from inspections where ${mediaClause};`,
    // v1/v2 location rows did not have a source column. This apiary is the
    // explicit reconciliation scope, so rebuild its location history in full.
    `delete from hive_location_history where apiary_id = ${apiaryId()};`,
  ];
}

function bootstrapSql() {
  const rows = currentLabels.map((label) => `insert into hives (apiary_id, position_label)
    select ${apiaryId()}, ${q(label)}
    where not exists (
      select 1 from hives
      where apiary_id = ${apiaryId()}
        and position_label = ${q(label)}
        and is_archived = false
    );`);

  return [
    `insert into apiaries (name, notes)
     select 'Lenoir Apiary', 'Created by the curated Obsidian history import.'
     where not exists (select 1 from apiaries where name = 'Lenoir Apiary');`,
    ...rows,
    `insert into jar_sizes (label, honey_oz, sort_order)
     select 'Pint', 22, 10
     where not exists (select 1 from jar_sizes where label = 'Pint');`,
    `insert into jar_sizes (label, honey_oz, sort_order)
     select 'Quart', 44, 20
     where not exists (select 1 from jar_sizes where label = 'Quart');`,
  ];
}

function identitySql(identity) {
  const status = identity.status || "active";
  const archived = identity.archived === true;
  const label = identity.currentLabel || identity.positionLabel;
  const note = `${identity.note}\n\n${identityMarker(identity.key)}`;
  const deadout = status === "dead" ? ts(identity.ended) : "null";

  if (identity.currentLabel) {
    const marker = q(`%${identityMarker(identity.key)}%`);
    return `update hives
      set position_label = ${q(label)},
          status = 'active',
          installed_date = ${ts(identity.installed)},
          is_archived = false,
          deadout_date = null,
          notes = case
            when notes is null or btrim(notes) = '' or notes like ${marker} then ${q(note)}
            else notes || E'\\n\\n' || ${q(note)}
          end
      where id = (
        select id from hives
        where apiary_id = ${apiaryId()}
          and (notes like ${marker}
            or (position_label = ${q(identity.currentLabel)} and is_archived = false))
        order by (notes like ${marker}) desc, created_at
        limit 1
      );`;
  }

  return `insert into hives (
      apiary_id, position_label, status, installed_date, is_archived, deadout_date, notes
    )
    select ${apiaryId()}, ${q(label)}, ${q(status)}, ${ts(identity.installed)}, ${archived ? "true" : "false"}, ${deadout}, ${q(note)}
    where not exists (
      select 1 from hives where notes like ${q(`%${identityMarker(identity.key)}%`)}
    );
    update hives
      set position_label = ${q(label)},
          status = ${q(status)},
          installed_date = ${ts(identity.installed)},
          is_archived = ${archived ? "true" : "false"},
          deadout_date = ${deadout},
          notes = ${q(note)}
      where notes like ${q(`%${identityMarker(identity.key)}%`)};`;
}

function locationSql(identity) {
  return identity.locations.map(([from, to, label]) => `insert into hive_location_history (
      hive_id, apiary_id, position_label, date_from, date_to
    )
    select ${identityId(identity.key)}, ${apiaryId()}, ${q(label)}, ${ts(from)}, ${to ? ts(to) : "null"}
    where ${identityId(identity.key)} is not null;`);
}

function splitSql([date, parent, child, type, framesMoved, note]) {
  return `insert into hive_splits (
      parent_hive_id, child_hive_id, split_date, split_type, frames_moved, notes
    )
    select ${identityId(parent)}, ${identityId(child)}, ${ts(date)}, ${q(type)},
      ${framesMoved == null ? "null" : framesMoved},
      ${q(`${note}\n\n${source("Journal lineage", date, `${parent}->${child}`)}`)}
    where ${identityId(parent)} is not null and ${identityId(child)} is not null;`;
}

function inspectionSql([date, keys, file, note, fields = {}]) {
  return keys.map((key) => {
    const sourceMedia = {
      import: importTag,
      source: "obsidian",
      file,
      date,
      identity: key,
    };
    return `insert into inspections (
        hive_id, date, queen_seen, brood_pattern, pests, treatments, notes, source_media
      )
      select ${identityId(key)}, ${ts(date)},
        ${fields.queenSeen == null ? "null" : fields.queenSeen ? "true" : "false"},
        ${q(fields.broodPattern)}, ${json(fields.pests)}, ${json(fields.treatments)},
        ${q(`${note}\n\n${source(file, date, key)}`)}, ${json(sourceMedia)}
      where ${identityId(key)} is not null;`;
  });
}

function treatmentSql([date, keys, file, note]) {
  return inspectionSql([
    date,
    keys,
    file,
    note,
    {
      pests: [{ type: "mites" }],
      treatments: [{ product: "Oxalic acid", method: "vaporization", dateApplied: date }],
    },
  ]);
}

function feedingSql(event) {
  return event.keys.map((key) => `insert into feedings (
      hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes
    )
    select ${identityId(key)}, ${ts(event.date)}, ${q(event.type)}, ${event.quantity},
      ${q(event.unit)}, ${q(event.feederType)},
      ${q(`${event.note}\n\n${source(event.file, event.date, key)}`)}
    where ${identityId(key)} is not null;`);
}

function queenSql(queen) {
  const hiveId = queen.hiveKey ? identityId(queen.hiveKey) : "null";
  const originHiveId = queen.originHiveKey ? identityId(queen.originHiveKey) : "null";
  const parentQueenId = queen.parentQueenKey ? queenId(queen.parentQueenKey) : "null";
  const sourceFile = queen.sourceFile || "Journal queen notes";
  const sourceDetail = queen.sourceDetail || queen.key;
  const notes = `${queen.note}\n\n${queenMarker(queen.key)}\n${source(sourceFile, queen.date, sourceDetail)}`;
  const requiredIds = [
    queen.hiveKey ? `${hiveId} is not null` : null,
    queen.originHiveKey ? `${originHiveId} is not null` : null,
    queen.parentQueenKey ? `${parentQueenId} is not null` : null,
  ].filter(Boolean);
  return `insert into queens (
      hive_id, origin, origin_hive_id, parent_queen_id, introduced_date, status, notes
    )
    select ${hiveId}, ${q(queen.origin)}, ${originHiveId}, ${parentQueenId},
      ${ts(queen.date)}, ${q(queen.status)}, ${q(notes)}
    ${requiredIds.length ? `where ${requiredIds.join(" and ")}` : ""};`;
}

function harvestSessionSql([sessionKey, date, weight, note]) {
  return `insert into harvest_sessions (apiary_id, date, total_extracted_weight, notes)
    select ${apiaryId()}, ${ts(date)}, ${weight},
      ${q(`${note}\n\n${source("Honey Journal.md", date, sessionKey)}`)}
    where ${apiaryId()} is not null;`;
}

function allocatedHarvestRows(sessionKey, rows) {
  const session = harvestSessions.find(([key]) => key === sessionKey);
  if (!session) throw new Error(`Unknown harvest session ${sessionKey}`);
  const [, date, extractedTotal] = session;
  const measuredTotal = rows.reduce((sum, [, measured]) => sum + measured, 0);
  let allocatedSoFar = 0;

  return rows.map(([key, measured], index) => {
    const allocated = index === rows.length - 1
      ? Number((extractedTotal - allocatedSoFar).toFixed(3))
      : Number(((measured / measuredTotal) * extractedTotal).toFixed(3));
    allocatedSoFar += allocated;
    const after = Number((measured - allocated).toFixed(3));
    const note = [
      `Measured honey/wax contribution: ${measured} lbs.`,
      `Allocated bucketed honey: ${allocated} lbs, proportional to this hive's measured contribution.`,
      `The allocation makes per-hive totals reconcile to the session's ${extractedTotal} lbs actually extracted.`,
      source("Honey Journal.md", date, `${sessionKey}; ${key}`),
    ].join("\n");

    return `insert into honey_harvests (
        session_id, hive_id, date, super_weight_before, super_weight_after,
        calculated_honey_weight, notes
      )
      select
        (select id from harvest_sessions
          where notes like ${q(`%${source("Honey Journal.md", date, sessionKey)}%`)}
          order by created_at limit 1),
        ${identityId(key)}, ${ts(date)}, ${measured}, ${after}, ${allocated}, ${q(note)}
      where ${identityId(key)} is not null;`;
  });
}

function movementSql(event) {
  const jarId = event.jarLabel
    ? `(select id from jar_sizes where label = ${q(event.jarLabel)} limit 1)`
    : "null";
  const sourceFile = event.sourceFile || "Honey Journal.md";
  return `insert into honey_movements (
      date, kind, amount_lbs, jar_size_id, quantity, reason, notes
    ) values (
      ${ts(event.date)}, ${q(event.kind)}, ${event.amountLbs ?? "null"}, ${jarId},
      ${event.quantity ?? "null"}, ${q(event.reason)},
      ${q(`${event.note}\n\n${source(sourceFile, event.date, event.sourceDetail)}`)}
    );`;
}

function saleSql(sale) {
  const marker = source(
    sale.sourceFile || inventreeSnapshot,
    sale.date,
    sale.sourceDetail || `${sale.orderRef}; shipment ${sale.shipmentRef}`,
  );
  const statements = [
    `insert into honey_sales (
        date, customer_name, location, total_amount, notes
      ) values (
        ${ts(sale.date)}, ${q(sale.customerName)}, ${q(sale.location)},
        ${sale.totalAmount}, ${q(`${sale.note}\n\n${marker}`)}
      );`,
  ];

  for (const line of sale.lines) {
    statements.push(`insert into honey_sale_items (
        sale_id, jar_size_id, quantity, unit_price
      )
      select
        (select id from honey_sales
          where notes like ${q(`%${marker}%`)}
          order by created_at limit 1),
        (select id from jar_sizes where label = ${q(line.jarLabel)} limit 1),
        ${line.quantity}, ${line.unitPrice};`);
  }
  return statements;
}

function validationSql() {
  return `
select 'active_hives' metric, count(*)::text value
from hives h join apiaries a on a.id = h.apiary_id
where a.name = 'Lenoir Apiary' and h.status = 'active' and h.is_archived = false
union all
select 'archived_identities', count(*)::text
from hives
where notes like '%[Obsidian identity:${importTag};%'
  and is_archived = true
union all
select 'open_locations', count(*)::text
from hive_location_history l join apiaries a on a.id = l.apiary_id
where a.name = 'Lenoir Apiary' and l.date_to is null
union all
select 'splits', count(*)::text
from hive_splits where notes like '%[Obsidian import:${importTag};%'
union all
select 'imported_inspections', count(*)::text
from inspections where source_media @> '{"import":"${importTag}"}'
union all
select 'imported_feedings', count(*)::text
from feedings where notes like '%[Obsidian import:${importTag};%'
union all
select 'imported_queens', count(*)::text
from queens where notes like '%[Obsidian queen:${importTag};%'
union all
select 'queen_parent_links', count(*)::text
from queens
where notes like '%[Obsidian queen:${importTag};%'
  and parent_queen_id is not null
union all
select 'harvest_sessions', count(*)::text
from harvest_sessions where notes like '%[Obsidian import:${importTag};%'
union all
select 'per_hive_harvests', count(*)::text
from honey_harvests where notes like '%[Obsidian import:${importTag};%'
union all
select 'honey_movements', count(*)::text
from honey_movements where notes like '%[Obsidian import:${importTag};%'
union all
select 'honey_sales', count(*)::text
from honey_sales where notes like '%[Obsidian import:${importTag};%'
union all
select 'honey_sale_items', count(*)::text
from honey_sale_items i
join honey_sales s on s.id = i.sale_id
where s.notes like '%[Obsidian import:${importTag};%';

select h.position_label current_position, l.position_label open_history_position
from hives h
join apiaries a on a.id = h.apiary_id
left join hive_location_history l on l.hive_id = h.id and l.date_to is null
where a.name = 'Lenoir Apiary'
  and h.status = 'active'
  and h.is_archived = false
  and (l.id is null or l.position_label <> h.position_label)
order by h.position_label;

select l.position_label, count(*) open_count
from hive_location_history l
join hives h on h.id = l.hive_id
where l.apiary_id = ${apiaryId()}
  and l.date_to is null
  and h.status = 'active'
  and h.is_archived = false
group by l.position_label
having count(*) <> 1
order by l.position_label;

select h.position_label, count(qn.id) active_queen_count
from hives h
join apiaries a on a.id = h.apiary_id
left join queens qn
  on qn.hive_id = h.id
 and qn.status = 'active'
 and qn.notes like '%[Obsidian queen:${importTag};%'
where a.name = 'Lenoir Apiary'
  and h.status = 'active'
  and h.is_archived = false
group by h.id, h.position_label
having count(qn.id) <> 1
order by h.position_label;

select s.date::date, s.customer_name, s.total_amount,
       coalesce(sum(i.quantity * i.unit_price), 0) line_total
from honey_sales s
left join honey_sale_items i on i.sale_id = s.id
where s.notes like '%[Obsidian import:${importTag};%'
group by s.id
having count(i.id) > 0
   and abs(s.total_amount - coalesce(sum(i.quantity * i.unit_price), 0)) > 0.001
order by s.date, s.customer_name;

with imported_jar_ledger as (
  select m.jar_size_id,
         sum(case
           when m.kind = 'jarring' then m.quantity
           when m.kind = 'give_away' then -m.quantity
           when m.kind = 'jar_adjustment' then m.quantity
           else 0
         end)::bigint quantity
  from honey_movements m
  where m.notes like '%[Obsidian import:${importTag};%'
    and m.jar_size_id is not null
  group by m.jar_size_id
  union all
  select i.jar_size_id, -sum(i.quantity)::bigint
  from honey_sale_items i
  join honey_sales s on s.id = i.sale_id
  where s.notes like '%[Obsidian import:${importTag};%'
  group by i.jar_size_id
)
select js.label, sum(l.quantity) imported_net_jars
from imported_jar_ledger l
join jar_sizes js on js.id = l.jar_size_id
group by js.label
order by js.label;

with imported_harvest as (
  select coalesce(sum(s.total_extracted_weight), 0) harvested_lbs
  from harvest_sessions s
  where s.notes like '%[Obsidian import:${importTag};%'
),
imported_bulk_out as (
  select coalesce(sum(m.amount_lbs), 0) bulk_out_lbs
  from honey_movements m
  where m.notes like '%[Obsidian import:${importTag};%'
    and m.kind in ('jarring', 'bulk_use', 'loss')
)
select round((h.harvested_lbs - o.bulk_out_lbs)::numeric, 3) imported_bulk_on_hand_lbs
from imported_harvest h cross join imported_bulk_out o;
`;
}

function buildSql() {
  const statements = ["begin;", ...bootstrapSql(), ...cleanupSql()];
  for (const identity of identities) statements.push(identitySql(identity));
  for (const identity of identities) statements.push(...locationSql(identity));
  for (const split of splits) statements.push(splitSql(split));
  for (const inspection of inspections) statements.push(...inspectionSql(inspection));
  for (const treatment of treatments) statements.push(...treatmentSql(treatment));
  for (const feeding of feedings) statements.push(...feedingSql(feeding));
  for (const queen of queens) statements.push(queenSql(queen));
  for (const session of harvestSessions) statements.push(harvestSessionSql(session));
  for (const [sessionKey, rows] of measuredHarvests) {
    statements.push(...allocatedHarvestRows(sessionKey, rows));
  }
  for (const movement of jarMovements) statements.push(movementSql(movement));
  for (const sale of correlatedHoneySales) statements.push(...saleSql(sale));
  if (process.env.ROLLBACK_ONLY === "1") {
    statements.push(validationSql(), "rollback;");
  } else {
    statements.push("commit;", validationSql());
  }
  return statements.join("\n");
}

function runPsql(sql) {
  const result = spawnSync(
    "docker",
    [
      "--context", dockerContext, "exec", "-i", dbContainer,
      "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", dbUser, "-d", dbName,
    ],
    { input: sql, encoding: "utf8", maxBuffer: 1024 * 1024 * 30 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
  process.stdout.write(result.stdout);
}

function currentCounts() {
  const query = `
select 'hives', count(*)::int from hives
union all select 'locations', count(*)::int from hive_location_history
union all select 'splits', count(*)::int from hive_splits
union all select 'inspections', count(*)::int from inspections
union all select 'feedings', count(*)::int from feedings
union all select 'queens', count(*)::int from queens
union all select 'harvest_sessions', count(*)::int from harvest_sessions
union all select 'honey_harvests', count(*)::int from honey_harvests
union all select 'honey_movements', count(*)::int from honey_movements
union all select 'honey_sales', count(*)::int from honey_sales
union all select 'honey_sale_items', count(*)::int from honey_sale_items;
`;
  return execFileSync(
    "docker",
    [
      "--context", dockerContext, "exec", dbContainer,
      "psql", "-U", dbUser, "-d", dbName, "-t", "-A", "-F", ",", "-c", query,
    ],
    { encoding: "utf8" },
  ).trim();
}

validateManifest();
const sql = buildSql();
if (process.env.DRY_RUN === "1") {
  process.stdout.write(sql);
} else if (process.env.COUNTS_ONLY === "1") {
  console.log(currentCounts());
} else {
  runPsql(sql);
}
