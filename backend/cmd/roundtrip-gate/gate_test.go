package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/biker2000on/beez-trackz/backend/internal/db"
	"github.com/biker2000on/beez-trackz/backend/internal/snapshot"
)

// The database half of the gate suite. Every test here skips cleanly without
// TEST_DATABASE_URL, and none of them touches the database that URL names:
// they create their own sibling databases and drop them, because the shared
// test database is TRUNCATEd out from under them by the honey suite.

const fixtureDatabase = "beez_roundtrip_gate_source"

func requireDatabase(t *testing.T) string {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	t.Setenv("TZ", "UTC")
	return url
}

// seededSource builds the fixture database of design section 8: small, but it
// touches every hazard the comparison matrix names — a self-referencing
// queen, a soft-deleted event beside its live siblings, an unattributed
// historical draw, a reversal pair, a voided bottling run, a sold and an
// unsold serial, a transfer pair, an equipment ledger built from adjustments,
// a no-FK transcript pointer set in a post-pass, jsonb written with unsorted
// keys, and a date that is a different calendar day from its timestamp.
func seededSource(ctx context.Context, t *testing.T, adminURL string) (string, *pgxpool.Pool) {
	t.Helper()
	return seededSourceNamed(ctx, t, adminURL, fixtureDatabase)
}

// seededSourceNamed is seededSource with the database name spelled out, so a
// suite that leaves its fixture in an unusual state (the legacy-source tests)
// cannot collide with the ordinary one.
func seededSourceNamed(ctx context.Context, t *testing.T, adminURL, database string) (string, *pgxpool.Pool) {
	t.Helper()
	sourceURL, cleanup, err := freshDatabase(ctx, adminURL, database)
	if err != nil {
		t.Fatalf("create the fixture database: %v", err)
	}
	t.Cleanup(cleanup)
	migrated, err := db.Connect(ctx, sourceURL)
	if err != nil {
		t.Fatalf("migrate the fixture database: %v", err)
	}
	migrated.Close()
	pool, err := openUTCPool(ctx, sourceURL)
	if err != nil {
		t.Fatalf("connect the fixture database: %v", err)
	}
	t.Cleanup(pool.Close)

	statements := []string{
		// Identity and configuration. The AI provider config carries a
		// credential key so the export's per-key exclusion is exercised.
		`INSERT INTO app_users (id, username, display_name, email, is_admin, password_hash)
		 VALUES ('00000000-0000-4000-8000-000000000001','beek','Beek','beek@example.com',true,'$2b$12$notarealhash')`,
		`INSERT INTO user_settings (id, display_name, ai_provider_config)
		 VALUES ('00000000-0000-4000-8000-000000000002','Beek',
		   '{"transcription":"whisper","apiKeys":{"anthropic":"sk-ant-secret","ollamaUrl":"http://ollama:11434"}}'::jsonb)`,

		// Apiary and colony. canvas_layout is written with unsorted keys and
		// a 1.0 literal: Postgres normalizes both, and the canonical encoder
		// must make the round trip digest-equal anyway.
		`INSERT INTO apiaries (id, name, canvas_layout, elevation_m, elevation_source, forage_radius_m)
		 VALUES ('10000000-0000-4000-8000-000000000001','Home yard',
		   '{"zoom": 1.0, "areas": [{"y": 2, "x": 1}], "scale": 100}'::jsonb, 312.5, 'terrain', 2500)`,
		`INSERT INTO hives (id, apiary_id, position_label) VALUES
		   ('11000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A1'),
		   ('11000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','A2')`,
		`INSERT INTO queens (id, hive_id, origin, introduced_date) VALUES
		   ('12000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','purchased','2025-05-01T12:00:00Z')`,
		`INSERT INTO queens (id, hive_id, origin, parent_queen_id, introduced_date) VALUES
		   ('12000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002','raised',
		    '12000000-0000-4000-8000-000000000001','2025-06-01T12:00:00Z')`,

		// An inspection on the far side of a UTC date boundary, with all four
		// jsonb columns populated and a named business timezone inside the
		// weather snapshot that must survive as a name.
		`INSERT INTO inspections (id, hive_id, date, pests, treatments, source_media, weather_snapshot,
		   frames_of_bees, frames_of_brood)
		 VALUES ('13000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001',
		   '2025-12-31T23:30:00Z',
		   '{"varroa": true, "beetles": false}'::jsonb,
		   '[{"product":"Apiguard","method":"tray"},{"product":"Oxalic","method":"dribble"}]'::jsonb,
		   '{"mediaFileId": null}'::jsonb,
		   '{"timezone":"America/New_York","tempC":3.5,"observedAt":"2025-12-31T18:30:00-05:00"}'::jsonb,
		   8, 4)`,
		// Two live events reconciled to the jsonb (migration 00034) plus a
		// soft-deleted third that must restore as history, not as live.
		`INSERT INTO treatment_events (id, hive_id, inspection_id, date_applied, product, method) VALUES
		   ('14000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001',
		    '13000000-0000-4000-8000-000000000001','2025-12-31T23:30:00Z','Apiguard','tray'),
		   ('14000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000001',
		    '13000000-0000-4000-8000-000000000001','2025-12-31T23:30:00Z','Oxalic','dribble')`,
		`INSERT INTO treatment_events (id, hive_id, date_applied, product, deleted_at)
		 VALUES ('14000000-0000-4000-8000-000000000003','11000000-0000-4000-8000-000000000001',
		   '2025-11-01T12:00:00Z','Formic','2025-11-02T12:00:00Z')`,

		// Harvest: a session true-up (00005), a direct-weight harvest (00011),
		// and a lot whose weight source is derived (00039).
		`INSERT INTO harvest_sessions (id, apiary_id, date, total_extracted_weight)
		 VALUES ('15000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
		   '2026-01-01T15:00:00Z', 61.5)`,
		`INSERT INTO harvest_session_true_ups (id, session_id, previous_weight_lbs, new_weight_lbs, reason)
		 VALUES ('16000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001',
		   60.0, 61.5, 'settled bucket weight')`,
		`INSERT INTO honey_harvests (id, session_id, hive_id, date, super_weight_before,
		   super_weight_after, calculated_honey_weight)
		 VALUES ('17000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001',
		   '11000000-0000-4000-8000-000000000001','2026-01-01T15:00:00Z', 90.0, 50.0, 40.0)`,
		`INSERT INTO honey_harvests (id, hive_id, date, super_weight_before, super_weight_after,
		   calculated_honey_weight, direct_weight)
		 VALUES ('17000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002',
		   '2026-01-02T15:00:00Z', 0, 0, 21.5, true)`,
		`INSERT INTO honey_varietals (id, name) VALUES
		   ('18000000-0000-4000-8000-000000000001','Wildflower')`,
		// extraction_date is a calendar date, deliberately the day after the
		// UTC instant above.
		`INSERT INTO harvest_lots (id, lot_code, public_slug, extraction_date, honey_weight_lbs,
		   varietal_id, honey_weight_source, testing_data)
		 VALUES ('19000000-0000-4000-8000-000000000001','LOT-1','lot-1','2026-01-02', 40.0,
		   '18000000-0000-4000-8000-000000000001','derived',
		   '{"moisture": 17.20, "hmf": 4}'::jsonb)`,

		// Bottling, including a voided run that stays as a record.
		`INSERT INTO jar_sizes (id, label, honey_oz, default_price_cents)
		 VALUES ('1a000000-0000-4000-8000-000000000001','Pint', 22, 1200)`,
		`INSERT INTO bottling_runs (id, lot_id, bottled_date, jar_size_id, quantity, honey_lbs)
		 VALUES ('1b000000-0000-4000-8000-000000000001','19000000-0000-4000-8000-000000000001',
		   '2026-01-03','1a000000-0000-4000-8000-000000000001', 10, 13.75)`,
		`INSERT INTO bottling_runs (id, lot_id, bottled_date, jar_size_id, quantity, honey_lbs,
		   voided_at, void_reason)
		 VALUES ('1b000000-0000-4000-8000-000000000002','19000000-0000-4000-8000-000000000001',
		   '2026-01-04','1a000000-0000-4000-8000-000000000001', 4, 5.5,
		   '2026-01-05T10:00:00Z','miscounted')`,

		// Commerce.
		`INSERT INTO customers (id, name, email) VALUES
		   ('1c000000-0000-4000-8000-000000000001','Corner Store','store@example.com')`,
		`INSERT INTO stock_locations (id, name, slug, is_consignment, customer_id, commission_bps)
		 VALUES ('1d000000-0000-4000-8000-000000000001','Corner Store','corner-store', true,
		   '1c000000-0000-4000-8000-000000000001', 2000)`,
		// A collected-versus-invoiced gap: paid is less than the total.
		`INSERT INTO sales (id, date, customer_id, total_amount_cents, amount_paid_cents, order_status,
		   stock_location_id)
		 VALUES ('1e000000-0000-4000-8000-000000000001','2026-01-10T16:00:00Z',
		   '1c000000-0000-4000-8000-000000000001', 3600, 1200, 'pending',
		   '1d000000-0000-4000-8000-000000000001')`,
		`INSERT INTO sale_items (id, sale_id, jar_size_id, quantity, unit_price_cents, kind,
		   bottling_run_id, cost_basis_cents)
		 VALUES ('1f000000-0000-4000-8000-000000000001','1e000000-0000-4000-8000-000000000001',
		   '1a000000-0000-4000-8000-000000000001', 3, 1200, 'jar',
		   '1b000000-0000-4000-8000-000000000001', 400)`,
		// One serial sold (sale_id and sold_at together, per the 00009 CHECK)
		// and one still on the shelf.
		`INSERT INTO jar_serials (id, bottling_run_id, serial_number, sale_id, sold_at) VALUES
		   ('20000000-0000-4000-8000-000000000001','1b000000-0000-4000-8000-000000000001','LOT-1-0001',
		    '1e000000-0000-4000-8000-000000000001','2026-01-10T16:00:00Z')`,
		`INSERT INTO jar_serials (id, bottling_run_id, serial_number) VALUES
		   ('20000000-0000-4000-8000-000000000002','1b000000-0000-4000-8000-000000000001','LOT-1-0002')`,
		// A transfer pair: home is the residual, so it is the negative half.
		`INSERT INTO stock_movements (id, date, kind, location_id, counterparty_location_id,
		   transfer_id, jar_size_id, quantity)
		 SELECT '21000000-0000-4000-8000-000000000001','2026-01-09T12:00:00Z','transfer', home.id,
		   '1d000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001',
		   '1a000000-0000-4000-8000-000000000001', -5
		 FROM stock_locations home WHERE home.slug = 'home'`,
		`INSERT INTO stock_movements (id, date, kind, location_id, counterparty_location_id,
		   transfer_id, jar_size_id, quantity)
		 SELECT '21000000-0000-4000-8000-000000000002','2026-01-09T12:00:00Z','transfer',
		   '1d000000-0000-4000-8000-000000000001', home.id,'22000000-0000-4000-8000-000000000001',
		   '1a000000-0000-4000-8000-000000000001', 5
		 FROM stock_locations home WHERE home.slug = 'home'`,

		// Honey movements: an attributed jarring draw that names its run and
		// the same lot the run names (00047 trigger), a historical draw with
		// no lot at all (the legacy-unassigned residual), and a reversal pair
		// whose reversal is negative and nets in the sum.
		`INSERT INTO honey_movements (id, date, kind, amount_lbs, jar_size_id, quantity,
		   bottling_run_id, lot_id)
		 VALUES ('23000000-0000-4000-8000-000000000001','2026-01-03T12:00:00Z','jarring', 13.75,
		   '1a000000-0000-4000-8000-000000000001', 10,'1b000000-0000-4000-8000-000000000001',
		   '19000000-0000-4000-8000-000000000001')`,
		`INSERT INTO honey_movements (id, date, kind, amount_lbs, reason)
		 VALUES ('23000000-0000-4000-8000-000000000002','2025-08-01T12:00:00Z','bulk_use', 2.5,
		   'historical draw with no lot')`,
		`INSERT INTO honey_movements (id, date, kind, amount_lbs, lot_id)
		 VALUES ('23000000-0000-4000-8000-000000000003','2026-01-06T12:00:00Z','loss', 1.5,
		   '19000000-0000-4000-8000-000000000001')`,
		`INSERT INTO honey_movements (id, date, kind, amount_lbs, lot_id, reverses_movement_id)
		 VALUES ('23000000-0000-4000-8000-000000000004','2026-01-07T12:00:00Z','loss', -1.5,
		   '19000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000003')`,

		// Expenses: one live, one soft-deleted that drops out of the live
		// total but stays as a record.
		`INSERT INTO expenses (id, expense_date, category, description, amount_cents)
		 VALUES ('24000000-0000-4000-8000-000000000001','2026-01-05','feed','Sugar', 24999)`,
		`INSERT INTO expenses (id, expense_date, category, description, amount_cents, deleted_at,
		   deletion_reason)
		 VALUES ('24000000-0000-4000-8000-000000000002','2026-01-06','feed','Duplicate', 24999,
		   '2026-01-07T09:00:00Z','entered twice')`,

		// Equipment: stock inserted at zero, then built by an adjustment, so
		// the 00006 reconcile guard computes the totals.
		`INSERT INTO equipment_types (id, name, category, frames_per_box)
		 VALUES ('25000000-0000-4000-8000-000000000001','Deep box','box', 10)`,
		`INSERT INTO equipment_stock (id, type_id, total_owned, unit_cost_cents)
		 VALUES ('26000000-0000-4000-8000-000000000001','25000000-0000-4000-8000-000000000001', 0, 2500)`,
		`INSERT INTO equipment_stock_adjustments (id, stock_id, quantity, reason, date, unit_cost_cents)
		 VALUES ('27000000-0000-4000-8000-000000000001','26000000-0000-4000-8000-000000000001', 12,
		   'purchased','2026-01-02T12:00:00Z', 2500)`,

		// Media: an original with a regenerable thumbnail, an audio file, and
		// a transcript version whose pointer back onto media_files has no
		// foreign key and is therefore a post-pass.
		`INSERT INTO photos (id, owner_type, owner_id, original_key, original_ref, thumbnail_key, tags)
		 VALUES ('28000000-0000-4000-8000-000000000001','hive','11000000-0000-4000-8000-000000000001',
		   'photos/one.jpg','photos/one.jpg','photos/one.thumb.jpg','{"b":1,"a":"frame"}'::jsonb)`,
		`INSERT INTO media_files (id, audio_key, owner_type, owner_id, transcription_status)
		 VALUES ('29000000-0000-4000-8000-000000000001','audio/one.m4a','hive',
		   '11000000-0000-4000-8000-000000000001','complete')`,
		`INSERT INTO transcript_versions (id, media_file_id, provider, text)
		 VALUES ('2a000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000001',
		   'whisper','two frames of brood')`,
		`UPDATE media_files SET current_transcript_version_id = '2a000000-0000-4000-8000-000000000001'
		 WHERE id = '29000000-0000-4000-8000-000000000001'`,

		// Accounting replay state, including the token the export must strip
		// and a last_synced_at that is an attempt, not a success.
		`INSERT INTO external_sync (id, system, entity_type, entity_id, external_id, sync_state,
		   conflict_state, content_hash, remote_transaction_guid, remote_enter_date, last_synced_at)
		 VALUES ('2b000000-0000-4000-8000-000000000001','gnucash_web','sale',
		   '1e000000-0000-4000-8000-000000000001','sale:1e000000-0000-4000-8000-000000000001','synced',
		   'none','hash-abc','gc-77','2026-01-10T16:05:00Z','2026-01-10T16:05:01Z')`,
		`INSERT INTO gnucash_sync_settings (id, base_url, api_token, book_guid, book_name,
		   root_currency, changes_cursor, sync_enabled, account_mapping, last_synced_at, restore_state)
		 VALUES (true,'https://folio.example','gcw_secret_token','book-1','Yard Books','USD',
		   'cursor-42', false, '{"cash":"guid-1","revenue":{"jar":"guid-2"}}'::jsonb,
		   '2026-01-11T02:00:00Z','none')`,
	}
	for index, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("seed statement %d: %v\n%s", index, err, statement)
		}
	}
	return sourceURL, pool
}

// The source artifact of a real export must pass the gate's own independent
// checksum, digest, reference, and media passes with nothing to report. If it
// does not, every later comparison is meaningless.
func TestChecksumPassAcceptsASeededExport(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	_, pool := seededSource(ctx, t, adminURL)
	directory := filepath.Join(t.TempDir(), "artifact")
	if _, err := snapshot.Export(ctx, pool, snapshot.ExportOptions{
		OutputDirectory: directory, BusinessTimezone: "UTC", Currency: "USD",
	}); err != nil {
		t.Fatalf("export the fixture: %v", err)
	}
	loaded, findings := loadArtifact(directory)
	if loaded == nil {
		t.Fatalf("the export did not load: %v", findings)
	}
	if got := failures(findings); len(got) != 0 {
		for _, item := range got {
			t.Errorf("%s: %s", item.Code, item.Detail)
		}
		t.Fatal("a fresh export failed the gate's own checksum pass")
	}
	// The secrets the format spec excludes must not be anywhere in the bytes
	// (adversarial case A11).
	for _, secret := range []string{"gcw_secret_token", "sk-ant-secret", "$2b$12$notarealhash"} {
		if artifactContains(t, directory, secret) {
			t.Errorf("the artifact contains the excluded secret %q", secret)
		}
	}
	// An artifact that exports honey movements must export the unattributed
	// draw as the unassigned bucket rather than inventing a lot for it.
	unassigned := 0
	for _, record := range loaded.Records["honey_movements"] {
		if record.Fields["lot_id"] == nil {
			unassigned++
		}
	}
	if unassigned != 1 {
		t.Fatalf("expected exactly one legacy-unassigned draw, found %d", unassigned)
	}
}

// The whole runbook, end to end, against the seeded fixture. It needs the
// importer CLI, which is the Wave 2 sibling: without it the gate cannot
// restore anything, and the test says so rather than reporting a failure for
// work that is not in this tree.
func TestRoundTripGatePassesAgainstASeededFixture(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	repoRoot, err := findRepoRoot(".")
	if err != nil {
		t.Fatalf("locate the backend module: %v", err)
	}
	workdir := t.TempDir()
	if _, err := buildImporter(ctx, repoRoot, workdir); err != nil {
		if errors.Is(err, errImporterMissing) {
			t.Skipf("%v; the round-trip gate needs the Wave 2 importer to restore anything", err)
		}
		t.Fatalf("build the importer: %v", err)
	}

	sourceURL, _ := seededSource(ctx, t, adminURL)
	report, err := run(ctx, options{
		AdminURL: adminURL, SourceURL: sourceURL, Workdir: workdir,
		GateDatabase: gateDatabaseName, RepoRoot: repoRoot,
		Logf: func(format string, args ...any) { t.Logf(format, args...) },
	})
	if err != nil {
		t.Fatalf("run the gate: %v", err)
	}
	if err := writeReports(report, workdir); err != nil {
		t.Fatalf("write the gate report: %v", err)
	}
	if !report.Passed {
		t.Log(report.summary())
		t.Fatalf("the round-trip gate failed with %d findings", len(report.Failures))
	}
	for _, name := range []string{"gate-report.json", "gate-summary.txt", "artifact.sha256"} {
		if _, err := os.Stat(filepath.Join(workdir, name)); err != nil {
			t.Errorf("the gate did not write %s: %v", name, err)
		}
	}
	// The report must never be written inside the artifact the checksum
	// covers.
	if _, err := os.Stat(filepath.Join(workdir, "artifact", "restore-report.json")); err == nil {
		t.Error("a restore report was written inside the snapshot artifact")
	}
}

// A corrupt artifact must fail the gate at the checksum step, before the
// disposable database is created and long before any restore runs.
func TestRoundTripGateStopsOnACorruptArtifact(t *testing.T) {
	adminURL := requireDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	_, pool := seededSource(ctx, t, adminURL)
	directory := filepath.Join(t.TempDir(), "artifact")
	if _, err := snapshot.Export(ctx, pool, snapshot.ExportOptions{
		OutputDirectory: directory, BusinessTimezone: "UTC", Currency: "USD",
	}); err != nil {
		t.Fatalf("export the fixture: %v", err)
	}
	path := filepath.Join(directory, "domains", "apiaries.jsonl")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content[len(content)/2] ^= 0x20
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	_, findings := loadArtifact(directory)
	if !hasCode(findings, "manifest-hash-mismatch") {
		t.Fatalf("a corrupt export was accepted: %v", codes(findings))
	}
}

func artifactContains(t *testing.T, directory, needle string) bool {
	t.Helper()
	found := false
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || found {
			return err
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if len(needle) > 0 && containsBytes(content, needle) {
			found = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scan the artifact: %v", err)
	}
	return found
}

func containsBytes(content []byte, needle string) bool {
	return len(needle) > 0 && len(content) >= len(needle) &&
		indexOf(string(content), needle) >= 0
}

func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}
