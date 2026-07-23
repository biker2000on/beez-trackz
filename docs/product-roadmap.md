# Beez Trackz — Product Roadmap

Feature ideas for the Go/Next.js stack, grouped by theme. Roughly ordered by
value-for-effort within each section. (Drafted 2026-07-23, after the stack
rewrite cutover.)

## High value for how the apiary actually runs

### Photo migration + inspection photos on the timeline
The legacy filesystem photos were never imported into MinIO (the `photos`
table is empty; originals still live in the old data volume on TrueNAS, with a
pg_dump backup alongside). Import them with an adapted `cmd/migrate-legacy`,
then render photos inline on inspection cards for a visual hive history.

### Voice-first everything
The transcription pipeline only creates inspections today. Extend the parser
so one walkthrough recording can also extract:
- feedings ("gave A3 two quarts of 1:1")
- treatments ("put Apivar strips in B2")
- queen events ("saw a new queen in A4, superseded")

### Overwintering & survival analytics
Deadout dates, location history, and queen lineage already exist. A
winter-survival report by apiary, stand position, and queen line turns the
records into decisions (which yard, which genetics).

### Varroa tracking done properly
Structured mite-count fields (alcohol wash / sticky board counts) instead of
free-text pest counts, with per-hive trend charts and treatment-efficacy
overlays (counts before vs. after each treatment).

## Data already in the database, one query away

### Hive timeline view
A single chronological feed per hive merging inspections, feedings,
treatments, splits, harvests, queen changes, and moves.

### Honey yield by hive / apiary / year
Harvests are recorded per hive; add a yield leaderboard and year-over-year
comparison.

### Queen performance scoring
Connect lineage to outcomes: brood pattern ratings, temperament, survival,
and honey yield rolled up per queen and per mother line, displayed on the
genealogy tree.

## Field usability

### True offline mode
The legacy offline queue was dead code and was dropped in the rewrite. The
PWA + Go API is a clean foundation for a real one: queue mutations in
IndexedDB, replay on reconnect with conflict detection.

### NFC / QR tags on hives
Scan a tag at the hive to jump straight to its page or start a recording.
The canvas already knows physical positions.

### Weather integration
Apiaries have lat/lng. Auto-attach conditions to inspections; warn about
upcoming cold snaps when feeders are light.

## Longer arc

### Bloom calendar intelligence
Bloom observations are being recorded; correlate them with harvest timing
across years to predict flow starts.

### MCP server for the Go API
The legacy app exposed one. Re-adding it lets an AI assistant answer
questions like "which hives haven't been inspected since the flow started?"
from any MCP client.

### Multi-user support
`user_settings` is single-row by design. If anyone else ever helps with the
bees, per-user identities over shared data is the one structural change to
plan for.
