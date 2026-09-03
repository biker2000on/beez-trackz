// Package app is the application layer: commands that run under an explicit
// actor inside an explicit transaction, with errors typed by what the caller
// should do rather than by an HTTP status.
//
// It exists because of the P0 importer contract (docs/product-roadmap.md,
// "Portable snapshot and verified restore" — amended 2026-09-01). The snapshot
// restore cannot go through the HTTP API: no endpoint accepts a client-supplied
// id, created_at, created_by, deleted_at, or voided_at, and soft-deleted,
// voided, and reversed history cannot be recreated through user commands with
// matching audit timestamps. It also must not be a table copier like
// cmd/migrate-legacy, because the contract requires domain validation and
// reference resolution. This package is the third thing: domain-aware
// commands that are additionally allowed to write preserved identity and
// audit fields.
//
// This is Wave 1 — the importer-facing slice only. There is no generic
// service registry, no repository interface for reads, no dependency
// injection container. Wave 2 adds domains by adding repositories, not by
// reshaping this.
//
// # Actors
//
// Every unit of work runs as an [Actor]. The privilege that matters here is
// [Actor.MayWritePreservedAudit], held only by [SystemRestoreActor]. It is
// deliberately NOT "admin": admin is an end-user authorization level that
// still may not forge audit history, and no HTTP session can produce the
// restore actor. Repositories check it through the driver before any write.
//
// # Unit of work
//
// [Runner.Run] opens one pgx transaction, hands a [UnitOfWork] to a function,
// and commits when it returns nil. Any error rolls back and is returned
// unchanged so its [Kind] survives; a panic rolls back and re-panics.
// [UnitOfWork.Savepoint] nests, which is how one bad record is isolated from
// the records that already succeeded in the same run.
//
// [Runner.DryRun] is the contract's no-write validation pass: the transaction
// is rolled back even on success, and [UnitOfWork.DryRun] additionally tells
// repositories to skip record inserts. Transactional target normalization
// such as [SeededRowsYieldToSnapshot] still runs so validation sees the same
// logical target as a real restore; the unconditional rollback removes it.
// Anything that escapes the transaction — object storage, outbound HTTP,
// notifications — must be skipped by the caller when DryRun is set, because a
// rollback cannot undo it.
//
// # Errors
//
// [Error] carries a [Kind] (invalid, not_found, conflict, forbidden,
// precondition, unsupported, internal), the operation, and optionally the
// field at fault. Nothing in this package knows about HTTP; each edge maps
// Kind to its own vocabulary. classifyPg turns the SQLSTATEs a restore
// actually hits — unique, foreign key, check, not-null, and trigger RAISE —
// into those kinds with the constraint name attached, because "duplicate key
// value violates unique constraint" is not an actionable error for an
// operator holding a snapshot artifact.
//
// # Restore repository conventions
//
// Wave 2 extends this by writing more repositories. The conventions are not
// optional; the round-trip gate compares every record by preserved ID and
// canonical digest, so a repository that quietly normalizes a value fails the
// gate rather than the review.
//
//  1. One record type per domain concept, not per table. It decodes a
//     snapshot JSONL line and is independent of both the HTTP DTO and the
//     column list, so a schema change is a repository change and not a
//     format change. It implements [Record]: preserved ID plus domain name.
//
//  2. Implement [Repository] and let [Restore] drive. The driver owns the
//     ordering — privilege, id present, Validate, Resolve, Load, Equal,
//     conflict policy — so restore semantics stay in one place and cannot
//     drift between domains.
//
//  3. Preserved IDs and audit fields are written directly. INSERT lists id,
//     created_at, updated_at, and whichever of created_by, deleted_at,
//     deleted_by, and voided_at the table has. Never gen_random_uuid(),
//     never now(). Use [Audit] and call its validate from Validate.
//
//  4. updated_at survives an INSERT and not an UPDATE. The set_updated_at
//     triggers are BEFORE UPDATE only, so a created row keeps the artifact's
//     updated_at while [ConflictOverwrite] stamps now(). Overwrite is a
//     repair path; a faithful restore targets an empty database.
//
//  5. Validate ahead of the constraint. Every CHECK, allowlist, and paired
//     nullable is re-stated in Go with a message naming the field.
//     [ApiaryRestoreRepository] is the worked example: bounded numeric,
//     paired nullable, and enumerated source.
//
//  6. Resolve names both ends. A missing reference is [KindNotFound] with the
//     referring record and the referenced ID in the message, produced before
//     the write so the error is about the artifact rather than about
//     SQLSTATE 23503. A domain with no references still implements Resolve,
//     as a no-op with a comment saying why.
//
//  7. Equal is semantic. Compare normalized fields and created_at; never
//     compare updated_at, and never compare jsonb byte for byte — Postgres
//     does not preserve key order and rewrites numeric literals, so use
//     equalJSON. Equal is what makes a second import a no-op instead of a
//     wall of conflicts.
//
//  8. Conflicts are reported, never guessed. A preserved ID that exists with
//     different content yields [OutcomeConflicted] and a [KindConflict] error
//     unless the run explicitly chose [ConflictSkip] or [ConflictOverwrite].
//
//  9. NULL and empty string are different, because the schema treats them
//     differently (customers.email NULL is "no address"; an empty string
//     collides in the unique lower(email) index). Records use *string, and
//     Validate rejects a present-but-blank value rather than storing it.
//
//  10. Ordering that a topological sort over files cannot express belongs to
//     the caller, not to a repository: the no-FK pointers
//     (media_files.current_transcript_version_id, both reverses_movement_id
//     self-references) are a post-pass, equipment stock is inserted at zero
//     and its adjustments replayed, and bottling runs precede their
//     movements. A repository restores one record and says what happened.
//
//  11. Format-v1 legacy table replay targets an EMPTY, newly migrated
//     database. It never restores legacy inventory domains into a Phase-A
//     database carrying the inventory_legacy_freeze trigger: that database's
//     immutable ledger is already authoritative. The importer checks this
//     precondition before restoring any record.
//
// # What lives elsewhere
//
// The snapshot format, the exporter, and verification.json are Wave 1 too but
// belong to backend/internal/snapshot and docs/snapshot-format.md. The
// importer that walks an artifact through these repositories, and the
// round-trip driver, are Wave 2.
package app
