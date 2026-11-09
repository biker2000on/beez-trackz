// Regenerates the bundled Comb Bee icon set (PWA icons, apple-touch icon,
// favicon.ico) from the same hex geometry as FallbackMark in
// src/components/logo.tsx.
//
//   node scripts/brand-icons.mjs        write the icon files
//   node scripts/brand-icons.mjs print  print the 48x48 polygon points that
//                                       logo.tsx freezes as COMB_* constants
//
// If you change the geometry here, paste the printed points into logo.tsx.
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sharp = createRequire(import.meta.url)("sharp");
const FRONTEND = fileURLToPath(new URL("..", import.meta.url));

// --- Geometry --------------------------------------------------------------
// Flat-top hex cells on one grid. Neighbours sit along an edge normal at
// apothem + apothem + GAP, so every gap is the same width whatever the size of
// the two cells. Corners are softened by a same-colour round-join stroke of
// width 2 * SOFT, so polygons are drawn at radius - SOFT.
const APOTHEM = Math.sqrt(3) / 2;
const SOFT = 0.8;
const GAP = 1.5;
const R = 7.4;

const neighbour = ([x, y], r1, r2, deg) => {
  const d = APOTHEM * r1 + APOTHEM * r2 + GAP;
  const t = (deg * Math.PI) / 180;
  return [x + d * Math.cos(t), y - d * Math.sin(t)];
};

const thorax = [0, 0];
const abdomen = neighbour(thorax, R, R, -90);
const cells = {
  wing: [
    [neighbour(thorax, R, R, 150), R],
    [neighbour(thorax, R, R, 30), R],
    [neighbour(thorax, R, R * 0.7, 210), R * 0.7],
    [neighbour(thorax, R, R * 0.7, -30), R * 0.7],
  ],
  ink: [
    [neighbour(thorax, R, R * 0.6, 90), R * 0.6], // head
    [thorax, R],
    [neighbour(abdomen, R, R * 0.72, -90), R * 0.72], // tail
  ],
  band: [[abdomen, R]],
};

const hexPoints = ([cx, cy], r) =>
  [0, 60, 120, 180, 240, 300].map((d) => [
    cx + r * Math.cos((d * Math.PI) / 180),
    cy + r * Math.sin((d * Math.PI) / 180),
  ]);

const all = Object.values(cells).flatMap((g) => g.flatMap(([c, r]) => hexPoints(c, r)));
const minX = Math.min(...all.map(([x]) => x));
const maxX = Math.max(...all.map(([x]) => x));
const minY = Math.min(...all.map(([, y]) => y));
const maxY = Math.max(...all.map(([, y]) => y));

/** Polygon point strings fitted into a size x size box with margin m. */
function groups(size = 48, m = 1.5) {
  const k = (size - 2 * m) / Math.max(maxX - minX, maxY - minY);
  const ox = size / 2 - (k * (minX + maxX)) / 2;
  const oy = size / 2 - (k * (minY + maxY)) / 2;
  const f = (n) => +n.toFixed(2);
  const out = { stroke: f(SOFT * 2 * k) };
  for (const [name, g] of Object.entries(cells)) {
    out[name] = g.map(([c, r]) =>
      hexPoints(c, r - SOFT).map(([x, y]) => `${f(ox + k * x)},${f(oy + k * y)}`).join(" "),
    );
  }
  return out;
}

if (process.argv[2] === "print") {
  console.log(JSON.stringify(groups(), null, 2));
  process.exit(0);
}

// --- Icons -----------------------------------------------------------------
// Fixed colours: icons are raster files outside the theme, so they use the
// light-mode palette — honey tile, paper wings, pale honey band, ink body.
const COLORS = { bg: "#d97706", wing: "#fbf7ef", band: "#f7c56e", ink: "#2b1d10" };

function svg({ size, inner, radius }) {
  const g = groups(inner);
  const off = (size - inner) / 2;
  const grp = (fill, list) =>
    `<g fill="${fill}" stroke="${fill}">${list.map((p) => `<polygon points="${p}"/>`).join("")}</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${COLORS.bg}"/>` +
    `<g transform="translate(${off} ${off})" stroke-width="${g.stroke}" stroke-linejoin="round">` +
    grp(COLORS.wing, g.wing) + grp(COLORS.ink, g.ink) + grp(COLORS.band, g.band) +
    `</g></svg>`
  );
}

const png = (o) => sharp(Buffer.from(svg(o))).png({ compressionLevel: 9 }).toBuffer();
// Rounded tile for "any"-purpose icons and the favicon.
const tile = (n, k = 0.62) => png({ size: n, inner: Math.round(n * k), radius: n * 0.22 });
// Full-bleed square for maskable and apple-touch (the OS applies the mask).
// 0.52 keeps the whole bee inside the maskable 80% safe circle.
const bleed = (n, k) => png({ size: n, inner: Math.round(n * k), radius: 0 });

const files = {
  "public/icons/icon-192.png": await tile(192),
  "public/icons/icon-512.png": await tile(512),
  "public/icons/icon-maskable-192.png": await bleed(192, 0.52),
  "public/icons/icon-maskable-512.png": await bleed(512, 0.52),
  "public/apple-touch-icon.png": await bleed(180, 0.6),
};
for (const [path, buf] of Object.entries(files)) {
  fs.writeFileSync(`${FRONTEND}${path}`, buf);
}

// favicon.ico: PNG-embedded entries at 16/32/48, with a larger bee at small
// sizes so it stays legible.
const entries = await Promise.all(
  [16, 32, 48].map(async (n) => [n, await tile(n, n <= 16 ? 0.8 : 0.72)]),
);
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(([n, buf], i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(n, e); // width
  header.writeUInt8(n, e + 1); // height
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(buf.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += buf.length;
});
fs.writeFileSync(
  `${FRONTEND}src/app/favicon.ico`,
  Buffer.concat([header, ...entries.map(([, buf]) => buf)]),
);

console.log(`wrote ${Object.keys(files).length + 1} icon files`);
