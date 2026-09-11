package httpapi

import (
	"github.com/google/uuid"
	"net/http"
	"strings"
	"time"
)

func (s *Server) handleApiaryInspectionCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID   uuid.UUID  `json:"apiaryId"`
		ObservedAt time.Time  `json:"observedAt"`
		Notes      string     `json:"notes"`
		CaptureID  *uuid.UUID `json:"captureId"`
		MutationID *uuid.UUID `json:"mutationId"`
	}
	if decodeJSON(r, &req) != nil || req.ApiaryID == uuid.Nil || strings.TrimSpace(req.Notes) == "" || req.ObservedAt.IsZero() || req.ObservedAt.After(time.Now().Add(5*time.Minute)) {
		writeError(w, 400, "Apiary, observation time, and notes are required")
		return
	}
	if !s.requireOwnerRole(w, r, "apiary", req.ApiaryID, true) {
		return
	}
	if req.CaptureID == nil {
		req.CaptureID = req.MutationID
	}
	var id uuid.UUID
	err := s.pool.QueryRow(r.Context(), `INSERT INTO apiary_inspections(apiary_id,observed_at,notes,created_by,capture_id) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT (created_by,capture_id) WHERE capture_id IS NOT NULL DO UPDATE SET capture_id=EXCLUDED.capture_id
 WHERE apiary_inspections.apiary_id=EXCLUDED.apiary_id AND apiary_inspections.observed_at=EXCLUDED.observed_at AND apiary_inspections.notes=EXCLUDED.notes RETURNING id`, req.ApiaryID, req.ObservedAt, req.Notes, actorID(r), req.CaptureID).Scan(&id)
	if err != nil {
		writeError(w, 409, "Could not save; this capture identity may already contain different observations")
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "apiaryId": req.ApiaryID, "observedAt": req.ObservedAt, "notes": req.Notes, "status": "saved", "apiaryInspectionIds": []uuid.UUID{id}})
}

func (s *Server) handleApiaryInspectionList(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("apiaryId"))
	if err != nil {
		writeError(w, 400, "apiaryId is required")
		return
	}
	if !s.requireOwnerRole(w, r, "apiary", id, false) {
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT id,observed_at,notes,created_at,source_media_file_id,source_transcript_version_id FROM apiary_inspections WHERE apiary_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 200`, id)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var record uuid.UUID
		var observed, created time.Time
		var notes string
		var media, version *uuid.UUID
		if err = rows.Scan(&record, &observed, &notes, &created, &media, &version); err != nil {
			writeError(w, 500, "database error")
			return
		}
		out = append(out, map[string]any{"id": record, "apiaryId": id, "observedAt": observed, "notes": notes, "createdAt": created, "sourceMediaFileId": media, "sourceTranscriptVersionId": version})
	}
	if rows.Err() != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, out)
}
