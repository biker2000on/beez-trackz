import { execFileSync, spawnSync } from "node:child_process";

const dockerContext = process.env.BEEZ_DOCKER_CONTEXT || "truenas";
const dbContainer = process.env.BEEZ_DB_CONTAINER || "beez-trackz-db-1";
const dbUser = process.env.BEEZ_DB_USER || "beeztrackz";
const dbName = process.env.BEEZ_DB_NAME || "beeztrackz";
const importTag = "obsidian-history-v2-curated";
const oldImportTags = ["obsidian-history-v1", importTag];

const allCurrentHives = [
  "A1",
  "A2",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3",
  "B4",
  "C1",
  "C2",
  "C3",
  "C4",
  "D1",
  "D2",
  "D3",
  "D4",
];

function source(file, date, detail) {
  return `[Obsidian import:${importTag}; ${file}; ${date}${detail ? `; ${detail}` : ""}]`;
}

function q(value) {
  if (value == null) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ts(value) {
  return `${q(value)}::timestamp`;
}

function json(value) {
  return value == null ? "null" : `${q(JSON.stringify(value))}::jsonb`;
}

function apiaryId() {
  return "(select id from apiaries where name = 'Lenoir Apiary' limit 1)";
}

function hiveId(label) {
  return `(select h.id from hives h join apiaries a on a.id = h.apiary_id where a.name = 'Lenoir Apiary' and h.position_label = ${q(label)} limit 1)`;
}

function labelsFor(spec) {
  if (spec === "all") return allCurrentHives;
  if (Array.isArray(spec)) return spec;
  return [spec];
}

const inspections = [
  {
    date: "2023-09-27",
    hives: "all",
    file: "Journal 2023.md",
    note: "Brood check across the yard found many colonies with weak/uncertain brood; cloudy conditions may have made eggs hard to see.",
    broodPattern: "weak or uncertain brood in several colonies",
  },
  {
    date: "2023-09-27",
    hives: "all",
    file: "Journal 2023.md",
    note: "Alcohol-wash mite testing started; results included 19 mites, one unreliable reused-alcohol sample, and 32 mites on the large swarm colony.",
    pests: [{ type: "mites" }],
  },
  {
    date: "2023-10-31",
    hives: ["D1"],
    file: "Journal 2023.md",
    note: "One weak colony looked like a mite-related collapse: few bees left, liquid on the bottom, and dead bees accumulating.",
    queenSeen: false,
    pests: [{ type: "mites" }],
  },
  {
    date: "2023-12-14",
    hives: ["D1"],
    file: "Journal 2023.md",
    note: "The colony previously expected to die was still alive after being moved aside.",
  },
  {
    date: "2024-03-04",
    hives: ["B2"],
    file: "Journal 2024.md",
    note: "One nearly dead split was combined with the remaining weak split.",
  },
  {
    date: "2024-04-16",
    hives: ["A1", "A3", "A4"],
    file: "Journal 2024.md",
    note: "Oldest spring splits had laying queens about five weeks after the walk-away split.",
    queenSeen: true,
    broodPattern: "eggs and larvae present",
  },
  {
    date: "2024-04-16",
    hives: ["D1"],
    file: "Journal 2024.md",
    note: "Top-box split was very small and was moved to a nuc box; boosted with a brood frame.",
    broodPattern: "eggs present but population small",
  },
  {
    date: "2024-04-27",
    hives: ["B1", "B2", "C1"],
    file: "Journal 2024.md",
    note: "Three failing back-rail colonies were combined into the last split of the season.",
    queenSeen: false,
  },
  {
    date: "2024-05-24",
    hives: ["C1", "C2"],
    file: "Journal 2024.md",
    note: "Queen-cell frames from the boosted nuc were split into two new nucs.",
    broodPattern: "queen cells present",
  },
  {
    date: "2024-06-09",
    hives: ["C1", "C2"],
    file: "Journal 2024.md",
    note: "Two recent nucs were abandoned with chilled sealed brood.",
    queenSeen: false,
  },
  {
    date: "2024-06-24",
    hives: ["B2", "C1", "D2"],
    file: "Journal 2024.md",
    note: "Original swarm colony had eggs in both boxes and queen cells; split down into three nucs.",
    broodPattern: "eggs and queen cells present",
  },
  {
    date: "2024-07-16",
    hives: ["A1"],
    file: "Journal 2024.md",
    note: "Mite count 2 mites per half-cup sample.",
    pests: [{ type: "mites", count: 2 }],
  },
  {
    date: "2024-07-16",
    hives: ["A2"],
    file: "Journal 2024.md",
    note: "Mite count 14 mites per half-cup sample; later targeted for oxalic acid treatment.",
    pests: [{ type: "mites", count: 14 }],
  },
  {
    date: "2024-07-16",
    hives: ["A3", "B4"],
    file: "Journal 2024.md",
    note: "Mite count 2 mites per half-cup sample.",
    pests: [{ type: "mites", count: 2 }],
  },
  {
    date: "2024-07-16",
    hives: ["A4", "C3", "C4"],
    file: "Journal 2024.md",
    note: "Low mite count: 1 mite per half-cup sample.",
    pests: [{ type: "mites", count: 1 }],
  },
  {
    date: "2024-07-16",
    hives: ["B3", "C2"],
    file: "Journal 2024.md",
    note: "Mite count 0 mites per half-cup sample.",
    pests: [{ type: "mites", count: 0 }],
  },
  {
    date: "2024-07-16",
    hives: ["B1"],
    file: "Journal 2024.md",
    note: "Queenless with no brood; received a frame from N1 containing eggs/young larvae and queen cups.",
    queenSeen: false,
    broodPattern: "no brood before boost frame",
  },
  {
    date: "2024-07-31",
    hives: ["A2"],
    file: "Journal 2024.md",
    note: "Changed into a different box/bottom board and combined with a nuc to provide a queen.",
    queenSeen: false,
  },
  {
    date: "2024-07-31",
    hives: ["D2"],
    file: "Journal 2024.md",
    note: "Swarm added to D2; expected to establish if queen was present.",
  },
  {
    date: "2024-08-19",
    hives: ["D2"],
    file: "Journal 2024.md",
    note: "D2 doing well with lots of brood from the added swarm.",
    queenSeen: true,
    broodPattern: "lots of brood",
  },
  {
    date: "2024-08-19",
    hives: ["C1", "D1"],
    file: "Journal 2024.md",
    note: "One nuc was dying and another had been dead for weeks; dead equipment was cleaned/frozen.",
    queenSeen: false,
  },
  {
    date: "2025-03-02",
    hives: ["D1", "B3", "B4"],
    file: "Journal 2025.md",
    note: "Deadouts after winter.",
    queenSeen: false,
  },
  {
    date: "2025-03-02",
    hives: ["A2"],
    file: "Journal 2025.md",
    note: "Very weak coming out of winter; boosted with brood from A3. Possible laying worker despite seeing a queen.",
    broodPattern: "weak/possible laying worker",
  },
  {
    date: "2025-03-02",
    hives: ["A3", "C4"],
    file: "Journal 2025.md",
    note: "Strong early-season colony.",
    broodPattern: "building strongly",
  },
  {
    date: "2025-03-19",
    hives: ["A3", "A4"],
    file: "Journal 2025.md",
    note: "Split with queen in the top and eggs left below for queen-cell raising.",
    queenSeen: true,
    broodPattern: "eggs present in bottom after split",
  },
  {
    date: "2025-04-03",
    hives: ["A1"],
    file: "Journal 2025.md",
    note: "Split because it was packed with bees; eggs/larvae were present in both parts.",
    broodPattern: "eggs and larvae in both split parts",
  },
  {
    date: "2025-04-03",
    hives: ["C2"],
    file: "Journal 2025.md",
    note: "Likely swarm source; queen/swarm cells in both boxes. Split with cells available for both parts.",
    broodPattern: "queen/swarm cells",
  },
  {
    date: "2025-04-03",
    hives: ["C4", "C1"],
    file: "Journal 2025.md",
    note: "C4 split by moving the top to C1; queen location unknown at split time.",
  },
  {
    date: "2025-04-13",
    hives: ["B2"],
    file: "Journal 2025.md",
    note: "Swarm colony had drawn all foundation but had no eggs, so a queen cell was added.",
    queenSeen: false,
  },
  {
    date: "2025-04-17",
    hives: ["D1", "D3", "D4"],
    file: "Journal 2025.md",
    note: "Top splits from A-row moved to D-row positions; these were the queen-right but smaller halves.",
    queenSeen: true,
  },
  {
    date: "2025-04-17",
    hives: ["B3"],
    file: "Journal 2025.md",
    note: "B3 is the top of the C2 split moved separate; not ready for honey supers.",
  },
  {
    date: "2025-04-28",
    hives: ["B3", "C1"],
    file: "Journal 2025.md",
    note: "New mated queen present and laying; colony still small.",
    queenSeen: true,
    broodPattern: "eggs and larvae",
  },
  {
    date: "2025-04-28",
    hives: ["C4", "D2"],
    file: "Journal 2025.md",
    note: "C4 was queenless with many queen cells and no eggs; split into two nucs at C4 and D2.",
    queenSeen: false,
    broodPattern: "queen cells, no eggs",
  },
  {
    date: "2025-05-13",
    hives: ["D2", "B3", "C4"],
    file: "Journal 2025.md",
    note: "Small/new split confirmed improving: D2 likely just starting to lay, B3 improved after boost, C4 moved up to a deep and building strongly.",
    queenSeen: true,
  },
  {
    date: "2025-06-11",
    hives: ["D2"],
    file: "Journal 2025.md",
    note: "D2 nuc probably dead after being too small and leaving.",
    queenSeen: false,
  },
  {
    date: "2025-06-25",
    hives: ["D2"],
    file: "Journal 2025.md",
    note: "D2 questionable queen: interspersed eggs/brood and all drone brood, possible laying worker.",
    broodPattern: "sporadic drone brood",
  },
  {
    date: "2025-08-05",
    hives: ["A2"],
    file: "Journal 2025.md",
    note: "A2 queenless with many queen cells.",
    queenSeen: false,
    broodPattern: "queen cells",
  },
  {
    date: "2025-08-22",
    hives: ["A2"],
    file: "Journal 2025.md",
    note: "New queen seen and starting to lay.",
    queenSeen: true,
    broodPattern: "new laying queen",
  },
  {
    date: "2025-09-22",
    hives: ["A1"],
    file: "Journal 2025.md",
    note: "Queenless but had some brood left and weak attempted queen cells.",
    queenSeen: false,
  },
  {
    date: "2025-09-22",
    hives: ["A3"],
    file: "Journal 2025.md",
    note: "Queenless with no brood or queen cells; dying and stacked onto A1.",
    queenSeen: false,
    broodPattern: "no brood",
  },
  {
    date: "2026-02-18",
    hives: ["A1", "A2", "B3", "C2"],
    file: "Journal 2026.md",
    note: "Deadout found during quick winter check.",
    queenSeen: false,
  },
  {
    date: "2026-03-01",
    hives: ["D4"],
    file: "Journal 2026.md",
    note: "Dead/queenless and moved/stacked onto D1.",
    queenSeen: false,
  },
  {
    date: "2026-03-15",
    hives: ["C1", "C4"],
    file: "Journal 2026.md",
    note: "Split with demaree board; C1 queen intentionally on top, C4 queen location unknown at split.",
  },
  {
    date: "2026-03-22",
    hives: ["D1", "A4"],
    file: "Journal 2026.md",
    note: "Split even though queens could not be found; planned to check top halves later.",
  },
  {
    date: "2026-03-28",
    hives: ["C3"],
    file: "Journal 2026.md",
    note: "Split with old yellow-marked queen moved to the top; queenless bottom left to raise queen.",
    queenSeen: true,
  },
  {
    date: "2026-03-28",
    hives: ["B1", "B2"],
    file: "Journal 2026.md",
    note: "B1 queen looked gone/failed and was paper-combined on top of B2.",
    queenSeen: false,
  },
  {
    date: "2026-03-28",
    hives: ["D1"],
    file: "Journal 2026.md",
    note: "D1 split was undone because the top was drone-heavy and had no queen cups.",
  },
  {
    date: "2026-04-04",
    hives: ["D2", "B3"],
    file: "Journal 2026.md",
    note: "Caught swarms and hived them at D2 and B3.",
    queenSeen: true,
  },
  {
    date: "2026-04-12",
    hives: ["C2"],
    file: "Journal 2026.md",
    note: "Successful top split from C4 moved here; eggs confirmed.",
    queenSeen: true,
    broodPattern: "eggs present",
  },
  {
    date: "2026-04-12",
    hives: ["B1"],
    file: "Journal 2026.md",
    note: "Top of C1 doing well and strong enough for a honey super.",
    queenSeen: true,
  },
  {
    date: "2026-04-12",
    hives: ["A3"],
    file: "Journal 2026.md",
    note: "A4 top/queenless split moved to A3; no mated queen visible yet.",
    queenSeen: false,
  },
  {
    date: "2026-04-19",
    hives: ["D4"],
    file: "Journal 2026.md",
    note: "C3 top with old yellow 2022 queen moved to D4.",
    queenSeen: true,
  },
  {
    date: "2026-04-19",
    hives: ["A1", "A3"],
    file: "Journal 2026.md",
    note: "A-row reorganized: A1 swarm moved into A3 spot; A4 honey-super brood/queen moved to A1.",
    queenSeen: true,
  },
  {
    date: "2026-04-25",
    hives: ["A1", "C2"],
    file: "Journal 2026.md",
    note: "Sold to Craig.",
  },
  {
    date: "2026-05-04",
    hives: ["B4", "A2"],
    file: "Journal 2026.md",
    note: "B4 top deep split to A2 with queen-right top; B4 bottom stayed in original position.",
    queenSeen: true,
  },
  {
    date: "2026-05-04",
    hives: ["A1", "A2"],
    file: "Journal 2026.md",
    note: "A1 swarm and failing A2 combined into a single box.",
    queenSeen: true,
  },
  {
    date: "2026-05-04",
    hives: ["A4", "B2"],
    file: "Journal 2026.md",
    note: "Given right-age brood to raise a new queen.",
    queenSeen: false,
  },
  {
    date: "2026-05-18",
    hives: ["D3", "C2"],
    file: "Journal 2026.md",
    note: "D3 top half split to C2 and boosted with one brood frame from D3.",
  },
  {
    date: "2026-05-18",
    hives: ["B3", "D2"],
    file: "Journal 2026.md",
    note: "Swarm nuc upsized to full deep.",
    queenSeen: true,
  },
  {
    date: "2026-05-18",
    hives: ["C1", "A4", "D1"],
    file: "Journal 2026.md",
    note: "New/superseded queen confirmed laying.",
    queenSeen: true,
    broodPattern: "fresh brood",
  },
];

const treatments = [
  ["2023-09-27", "all", "Journal 2023.md", "Oxalic acid vaporization, 3 g per hive after high mite counts."],
  ["2023-10-02", "all", "Journal 2023.md", "Oxalic acid vaporization, 3 g per hive."],
  ["2023-10-04", "all", "Journal 2023.md", "Oxalic acid vaporization, 3 g per hive."],
  ["2023-10-09", "all", "Journal 2023.md", "Oxalic acid vaporization, 3 g per hive."],
  ["2023-10-13", "all", "Journal 2023.md", "Oxalic acid vaporization, 4 g per hive."],
  ["2023-10-16", "all", "Journal 2023.md", "Oxalic acid vaporization, 4 g per hive."],
  ["2023-10-19", "all", "Journal 2023.md", "Oxalic acid vaporization, 4 g per hive."],
  ["2023-10-25", "all", "Journal 2023.md", "Oxalic acid vaporization, 4 g per hive."],
  ["2023-10-30", "all", "Journal 2023.md", "Final oxalic acid vaporization round, 4 g per hive."],
  ["2023-12-14", "all", "Journal 2023.md", "Oxalic acid vaporization, 4 g per hive at about 51 F."],
  ["2023-12-21", "all", "Journal 2023.md", "Oxalic acid vaporization, 4 g per hive."],
  ["2024-08-05", ["A2"], "Journal 2024.md", "Oxalic acid vaporization, 8 g."],
  ["2024-08-05", ["B1"], "Journal 2024.md", "Oxalic acid vaporization, 4 g."],
  ["2024-08-05", ["B2"], "Journal 2024.md", "Oxalic acid vaporization, 2 g per nuc side."],
  ["2024-08-05", ["D1"], "Journal 2024.md", "Oxalic acid vaporization, 2 g."],
  ["2024-08-12", ["A2"], "Journal 2024.md", "Oxalic acid vaporization follow-up, 4 g."],
  ["2025-09-06", "all", "Journal 2025.md", "Full-yard oxalic acid vaporization treatment."],
  ["2025-09-11", "all", "Journal 2025.md", "Full-yard oxalic acid vaporization treatment."],
  ["2025-09-17", "all", "Journal 2025.md", "Full-yard oxalic acid vaporization treatment; scheduled for 9/16, completed 9/17."],
  ["2025-09-22", "all", "Journal 2025.md", "Final full-yard oxalic acid vaporization treatment in the fall series."],
];

const feedings = [
  {
    date: "2023-09-27",
    hives: "all",
    file: "Journal 2023.md",
    quantity: 13.6,
    unit: "lbs",
    type: "dry_sugar",
    feederType: "other",
    note: "Historical note says 150 lbs sugar fed across 11 hives so far; stored as approximate per-hive allocation.",
  },
  {
    date: "2023-10-13",
    hives: "all",
    file: "Journal 2023.md",
    quantity: 1.5,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "frame",
    note: "Interior feeders topped with 1.5 gal syrup.",
  },
  {
    date: "2023-10-13",
    hives: ["D1", "D3", "D4"],
    file: "Journal 2023.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "top",
    note: "Splits received an additional 2 gal top feed.",
  },
  {
    date: "2024-03-31",
    hives: ["B2"],
    file: "Journal 2024.md",
    quantity: 3,
    unit: "quarts",
    type: "sugar_syrup_1to1",
    feederType: "other",
    note: "Captured swarm fed 3 qt syrup through the week.",
  },
  {
    date: "2024-04-07",
    hives: ["B2", "D2"],
    file: "Journal 2024.md",
    quantity: 1,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "other",
    note: "Made 2 gal syrup for the swarms; recorded as approximate split between swarm colonies.",
  },
  {
    date: "2024-07-06",
    hives: ["B2", "C1", "D2"],
    file: "Queen Rearing 2023.md",
    quantity: 1.5,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "frame",
    note: "Queenless/virgin split groups received 1.5 gal 1:1 in in-hive feeders.",
  },
  {
    date: "2024-07-31",
    hives: "all",
    file: "Journal 2024.md",
    quantity: 1.4,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Everyone fed from 50 lbs sugar mixed to about 16-18 gal total volume; recorded as approximate per-hive feed.",
  },
  {
    date: "2024-08-19",
    hives: ["A1", "A2", "A3", "A4", "B1", "B3", "B4", "C2", "C3", "C4", "D2"],
    file: "Journal 2024.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Full hives received 2 gal syrup.",
  },
  {
    date: "2024-08-19",
    hives: ["B2", "C1", "D1"],
    file: "Journal 2024.md",
    quantity: 1,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Nucs received 1 gal syrup.",
  },
  {
    date: "2024-09-16",
    hives: "all",
    file: "Journal 2024.md",
    quantity: 6.8,
    unit: "lbs",
    type: "dry_sugar",
    feederType: "other",
    note: "Fed 75 lbs sugar across the yard; no inspection.",
  },
  {
    date: "2024-10-04",
    hives: "all",
    file: "Journal 2024.md",
    quantity: 6.8,
    unit: "lbs",
    type: "dry_sugar",
    feederType: "other",
    note: "Fed another 75 lbs sugar across the yard for winter stores.",
  },
  {
    date: "2025-08-22",
    hives: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D1", "D3", "D4"],
    file: "Journal 2025.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "All 15 active hives received a 2 gal bucket from about 38 gal syrup / 90 lbs sugar.",
  },
  {
    date: "2025-09-22",
    hives: ["A1", "A2", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D1", "D3", "D4"],
    file: "Journal 2025.md",
    quantity: 2,
    unit: "gallons",
    type: "sugar_syrup_1to1",
    feederType: "bucket",
    note: "Fed active hives 2 gal syrup after fall inspection/treatment; one bucket left over because a hive was down.",
  },
];

const lineages = {
  A1: [
    ["2026-04-27", "A1 swarm nuc"],
    ["2026-05-04", "A1"],
  ],
  A2: [
    ["2026-05-04", "B4 top"],
    ["2026-05-04 12:00:00", "A2"],
  ],
  A3: [
    ["2026-04-19", "A1"],
    ["2026-04-19 12:00:00", "A3"],
  ],
  A4: [
    ["2026-03-22", "A4 bottom"],
    ["2026-04-19", "A4"],
  ],
  B1: [
    ["2026-03-15", "C1 top"],
    ["2026-04-12", "B1"],
  ],
  B2: [["2026-03-28", "B2"]],
  B3: [
    ["2026-04-04", "B3 swarm nuc"],
    ["2026-05-18", "B3"],
  ],
  B4: [
    ["2026-05-04", "B4 bottom"],
    ["2026-05-04 12:00:00", "B4"],
  ],
  C1: [
    ["2026-03-15", "C1 bottom"],
    ["2026-04-12", "C1"],
  ],
  C2: [
    ["2026-05-18", "D3 top"],
    ["2026-05-18 12:00:00", "C2"],
  ],
  C3: [
    ["2026-03-28", "C3 bottom"],
    ["2026-04-25", "C3"],
  ],
  C4: [
    ["2026-03-15", "C4 bottom"],
    ["2026-04-12", "C4"],
  ],
  D1: [
    ["2025-04-03", "A1 top"],
    ["2025-04-17", "D1"],
  ],
  D2: [
    ["2026-04-04", "D2 swarm nuc"],
    ["2026-05-18", "D2"],
  ],
  D3: [
    ["2025-04-03", "A3 top"],
    ["2025-04-17", "D3"],
  ],
  D4: [
    ["2026-04-19", "C3 top"],
    ["2026-04-19 12:00:00", "D4"],
  ],
};

const splits = [
  ["2025-04-03", "A1", "D1", "vertical", null, "A1 split during the early April 2025 split round; top later tracked at D1."],
  ["2025-04-03", "A3", "D3", "vertical", null, "A3 split during the early April 2025 split round; top later tracked at D3."],
  ["2025-04-03", "A4", "D4", "vertical", null, "A4 split during the early April 2025 split round; top later tracked at D4."],
  ["2025-04-03", "C2", "B3", "vertical", null, "C2 split three ways; top later tracked at B3."],
  ["2025-04-03", "C4", "C1", "vertical", null, "C4 top moved to C1 during the April 2025 split round."],
  ["2025-04-13", "C4", "B4", "nuc", 3, "C4 donated frames/queen-cell resources to make B4 split."],
  ["2026-03-15", "C1", "B1", "vertical", null, "C1 split; queen-right top later tracked as B1."],
  ["2026-03-15", "C4", "C2", "vertical", null, "C4 split; top later moved/tracked as C2."],
  ["2026-03-22", "A4", "A3", "vertical", null, "A4 split; top/queenless side later moved to A3."],
  ["2026-03-28", "C3", "D4", "vertical", null, "C3 split; queen-right top later moved to D4."],
  ["2026-04-19", "A4", "A1", "vertical", null, "A4 honey-super brood/queen moved to A1 during A-row reorganization."],
  ["2026-04-19", "C3", "D4", "vertical", null, "C3 queen-right top moved to D4."],
  ["2026-05-04", "B4", "A2", "vertical", null, "B4 top deep split moved to A2."],
  ["2026-05-18", "D3", "C2", "vertical", null, "D3 top half split to C2 spot."],
];

const queens = [
  ["2026-04-19", "C1", "raised", "active", "C1 new mated queen confirmed laying lightly after split."],
  ["2026-04-19", "C2", "raised", "active", "C2 split from C4 had a new mated queen laying."],
  ["2026-04-25", "C3", "raised", "active", "C3 new mated queen confirmed with circle brood."],
  ["2026-05-04", "C4", "raised", "active", "C4 superseded/requeened itself; new queen laying."],
  ["2026-05-04", "D4", "raised", "active", "D4 new queen laying after emergency brood frame."],
  ["2026-05-18", "A4", "raised", "active", "A4 new queen confirmed after fresh brood frame placed May 4."],
  ["2026-05-18", "D1", "raised", "active", "D1 superseded queen; fresh larvae and royal jelly confirmed."],
];

const harvestSessions = [
  ["2023-07-03", 203.5, "2023 wildflower harvest: 26 quarts + 96 pints, estimated 203.5 lbs."],
  ["2023-08-10", 93.5, "2023 sourwood harvest: estimated 8-9 gal / 93.5 lbs."],
  ["2024-06-16", 225.9, "2024 wildflower extraction."],
  ["2024-07-19", 88.945, "2024 sourwood extraction."],
  ["2025-06-17", 303.57, "2025 wildflower extraction."],
  ["2025-07-18", 255.81, "2025 sourwood extraction."],
];

const perHiveHarvests = [
  ["2025-06-17", "A1", 60.817],
  ["2025-06-17", "A2", 51.815],
  ["2025-06-17", "B1", 55.635],
  ["2025-06-17", "B2", 14.15],
  ["2025-06-17", "C2", 44.12],
  ["2025-06-17", "C3", 61.51],
  ["2025-06-17", "D3", 10.1],
  ["2025-06-17", "D4", 15.905],
  ["2025-07-18", "A1", 50.87],
  ["2025-07-18", "A2", 33.29],
  ["2025-07-18", "B2", 43.93],
  ["2025-07-18", "C2", 33.07],
  ["2025-07-18", "C3", 37.88],
  ["2025-07-18", "D1", 13.8],
  ["2025-07-18", "D3", 23.75],
  ["2025-07-18", "D4", 29.57],
];

const honeyMovements = [
  ["2025-06-17", "jarring", 110, "Quart", 80, "historical jarring", "2025 wildflower jars produced: 80 quart jars."],
  ["2025-06-17", "jarring", 66, "Pint", 48, "historical jarring", "2025 wildflower jars produced: 48 pint jars."],
  ["2025-06-17", "bulk_use", 7.5, null, null, "mead", "2025 wildflower harvest: 7.5 lbs set aside for mead."],
  ["2024-10-04", "jar_adjustment", null, "Pint", -67, "historical sold honey", "2024 sold honey summary: 67 pints sold."],
  ["2024-10-04", "jar_adjustment", null, "Quart", -17, "historical sold honey", "2024 sold honey summary: 17 quarts sold, 12 allocated personal use."],
];

function inspectionSql(event) {
  const rows = [];
  const treatmentsValue = event.treatments ?? null;
  for (const label of labelsFor(event.hives)) {
    const note = `${event.note}\n\n${source(event.file, event.date, label)}`;
    const sourceMedia = { import: importTag, source: "obsidian", file: event.file, date: event.date, hive: label };
    rows.push(`insert into inspections (hive_id, date, queen_seen, brood_pattern, pests, treatments, notes, source_media)
select ${hiveId(label)}, ${ts(event.date)}, ${event.queenSeen == null ? "null" : event.queenSeen ? "true" : "false"}, ${q(event.broodPattern)}, ${json(event.pests)}, ${json(treatmentsValue)}, ${q(note)}, ${json(sourceMedia)}
where ${hiveId(label)} is not null;`);
  }
  return rows;
}

function treatmentSql([date, hives, file, note]) {
  return inspectionSql({
    date,
    hives,
    file,
    note,
    pests: [{ type: "mites" }],
    treatments: [{ product: "Oxalic acid", method: "vaporization", dateApplied: date }],
  });
}

function feedingSql(event) {
  const rows = [];
  for (const label of labelsFor(event.hives)) {
    const note = `${event.note}\n\n${source(event.file, event.date, label)}`;
    rows.push(`insert into feedings (hive_id, date_fed, type, quantity, quantity_unit, feeder_type, notes)
select ${hiveId(label)}, ${ts(event.date)}, ${q(event.type)}, ${event.quantity}, ${q(event.unit)}, ${q(event.feederType)}, ${q(note)}
where ${hiveId(label)} is not null;`);
  }
  return rows;
}

function locationSql(label, segments) {
  const rows = [];
  for (let i = 0; i < segments.length; i++) {
    const [dateFrom, positionLabel] = segments[i];
    const next = segments[i + 1];
    rows.push(`insert into hive_location_history (hive_id, apiary_id, position_label, date_from, date_to)
select ${hiveId(label)}, ${apiaryId()}, ${q(positionLabel)}, ${ts(dateFrom)}, ${next ? ts(next[0]) : "null"}
where ${hiveId(label)} is not null and ${apiaryId()} is not null;`);
  }
  return rows;
}

function splitSql([date, parent, child, type, framesMoved, note]) {
  return `insert into hive_splits (parent_hive_id, child_hive_id, split_date, split_type, frames_moved, notes)
select ${hiveId(parent)}, ${hiveId(child)}, ${ts(date)}, ${q(type)}, ${framesMoved == null ? "null" : framesMoved}, ${q(`${note}\n\n${source("Journal lineage", date, `${parent}->${child}`)}`)}
where ${hiveId(parent)} is not null and ${hiveId(child)} is not null;`;
}

function queenSql([date, label, origin, status, note]) {
  return `insert into queens (hive_id, origin, introduced_date, status, notes)
select ${hiveId(label)}, ${q(origin)}, ${ts(date)}, ${q(status)}, ${q(`${note}\n\n${source("Journal queen notes", date, label)}`)}
where ${hiveId(label)} is not null;`;
}

function harvestSessionSql([date, weight, note]) {
  return `insert into harvest_sessions (apiary_id, date, total_extracted_weight, notes)
select ${apiaryId()}, ${ts(date)}, ${weight}, ${q(`${note}\n\n${source("Honey Journal.md", date)}`)}
where ${apiaryId()} is not null;`;
}

function perHiveHarvestSql([date, label, weight]) {
  return `insert into honey_harvests (session_id, hive_id, date, super_weight_before, super_weight_after, calculated_honey_weight, notes)
select null, ${hiveId(label)}, ${ts(date)}, ${weight}, 0, ${weight}, ${q(`Per-hive honey/wax contribution for ${label}.\n\n${source("Honey Journal.md", date, label)}`)}
where ${hiveId(label)} is not null;`;
}

function honeyMovementSql([date, kind, amountLbs, jarLabel, quantity, reason, note]) {
  const jarId = jarLabel ? `(select id from jar_sizes where label = ${q(jarLabel)} limit 1)` : "null";
  return `insert into honey_movements (date, kind, amount_lbs, jar_size_id, quantity, reason, notes)
values (${ts(date)}, ${q(kind)}, ${amountLbs == null ? "null" : amountLbs}, ${jarId}, ${quantity == null ? "null" : quantity}, ${q(reason)}, ${q(`${note}\n\n${source("Honey Journal.md", date)}`)});`;
}

function cleanupSql() {
  const notesClauses = oldImportTags.map((tag) => `notes like '%[Obsidian import:${tag}%'`).join(" or ");
  const mediaClauses = oldImportTags.map((tag) => `source_media @> '{"import":"${tag}"}'`).join(" or ");
  return [
    `delete from honey_sale_items where sale_id in (select id from honey_sales where ${notesClauses});`,
    `delete from honey_sales where ${notesClauses};`,
    `delete from honey_movements where ${notesClauses};`,
    `delete from honey_harvests where ${notesClauses};`,
    `delete from harvest_sessions where ${notesClauses};`,
    `delete from feedings where ${notesClauses};`,
    `delete from hive_splits where ${notesClauses};`,
    `delete from queens where ${notesClauses};`,
    `delete from inspections where ${mediaClauses};`,
    `delete from hive_location_history where apiary_id = ${apiaryId()};`,
  ];
}

function buildSql() {
  const statements = ["begin;", ...cleanupSql()];
  for (const event of inspections) statements.push(...inspectionSql(event));
  for (const treatment of treatments) statements.push(...treatmentSql(treatment));
  for (const event of feedings) statements.push(...feedingSql(event));
  for (const entry of harvestSessions) statements.push(harvestSessionSql(entry));
  for (const entry of perHiveHarvests) statements.push(perHiveHarvestSql(entry));
  for (const entry of honeyMovements) statements.push(honeyMovementSql(entry));
  for (const entry of queens) statements.push(queenSql(entry));
  for (const entry of splits) statements.push(splitSql(entry));
  for (const [label, segments] of Object.entries(lineages)) statements.push(...locationSql(label, segments));
  statements.push("commit;");
  return statements.join("\n");
}

function runPsql(sql) {
  const result = spawnSync(
    "docker",
    ["--context", dockerContext, "exec", "-i", dbContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", dbUser, "-d", dbName],
    { input: sql, encoding: "utf8", maxBuffer: 1024 * 1024 * 20 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
  process.stdout.write(result.stdout);
}

function countImportedRows() {
  const query = `
select 'inspections' table_name, count(*)::int count from inspections where source_media @> '{"import":"${importTag}"}' union all
select 'feedings', count(*)::int from feedings where notes like '%[Obsidian import:${importTag}%' union all
select 'harvest_sessions', count(*)::int from harvest_sessions where notes like '%[Obsidian import:${importTag}%' union all
select 'honey_harvests', count(*)::int from honey_harvests where notes like '%[Obsidian import:${importTag}%' union all
select 'honey_movements', count(*)::int from honey_movements where notes like '%[Obsidian import:${importTag}%' union all
select 'queens', count(*)::int from queens where notes like '%[Obsidian import:${importTag}%' union all
select 'hive_splits', count(*)::int from hive_splits where notes like '%[Obsidian import:${importTag}%' union all
select 'hive_location_history', count(*)::int from hive_location_history where apiary_id = (select id from apiaries where name = 'Lenoir Apiary' limit 1);
`;
  return execFileSync(
    "docker",
    ["--context", dockerContext, "exec", dbContainer, "psql", "-U", dbUser, "-d", dbName, "-t", "-A", "-F", ",", "-c", query],
    { encoding: "utf8" },
  ).trim();
}

const sql = buildSql();
if (process.env.DRY_RUN === "1") {
  console.log(sql);
} else {
  runPsql(sql);
  console.log("Imported row counts:");
  console.log(countImportedRows());
}
