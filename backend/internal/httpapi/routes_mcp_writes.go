package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MCP write tools. Each checks editor access first (so a viewer cannot probe
// for records), applies the dedupe rule, then reuses the REST handler.

func (s *Server) mcpRecordInspection(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	hiveID, err := mcpUUID(args, "hiveId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawDate, err := mcpRequiredString(args, "date")
	if err != nil {
		return mcpToolResult{}, err
	}
	_, day, err := mcpDay(rawDate, "date")
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireHive(r, *hiveID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeInspection, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateInspection(r.Context(), s.pool, *hiveID, day)
		},
		func() (mcpToolResult, error) {
			result, err := s.mcpCallJSONHandler(r, args, s.handleInspectionCreate)
			if err != nil {
				return result, err
			}
			if created, ok := result.StructuredContent.(map[string]any); ok {
				if raw, _ := created["id"].(string); raw != "" {
					if id, err := uuid.Parse(raw); err == nil {
						if err := closeOneShotInspectionTreatments(r.Context(), s.pool, id); err != nil {
							return mcpToolResult{}, fmt.Errorf("inspection %s saved, but closing one-shot treatments failed: %w", id, err)
						}
					}
				}
			}
			return result, nil
		})
}

func (s *Server) mcpUpdateInspection(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	id, err := mcpUUID(args, "inspectionId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireOwner(r, "inspection", *id, true); err != nil {
		return mcpToolResult{}, err
	}
	body := make(map[string]json.RawMessage, len(args))
	for key, value := range args {
		if key != "inspectionId" {
			body[key] = value
		}
	}
	if len(body) == 0 {
		return mcpToolResult{}, errors.New("give at least one inspection field to change")
	}
	recorder, err := mcpInvoke(r, s.handleInspectionUpdate, id, nil, body)
	if err != nil {
		return mcpToolResult{}, err
	}
	return mcpRecorderResult(recorder)
}

func (s *Server) mcpDeleteInspection(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	id, err := mcpUUID(args, "inspectionId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireOwner(r, "inspection", *id, true); err != nil {
		return mcpToolResult{}, err
	}
	var hiveID uuid.UUID
	var label string
	var date time.Time
	err = s.pool.QueryRow(r.Context(), `
		SELECT i.hive_id, h.position_label, i.date
		FROM inspections i JOIN hives h ON h.id = i.hive_id
		WHERE i.id = $1`, *id).Scan(&hiveID, &label, &date)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpToolResult{}, errors.New("inspection not found")
	}
	if err != nil {
		return mcpToolResult{}, err
	}
	recorder, err := mcpInvoke(r, s.handleInspectionDelete, id, nil, nil)
	if err != nil {
		return mcpToolResult{}, err
	}
	if recorder.Code < 200 || recorder.Code >= 300 {
		return mcpToolResult{}, mcpRecorderError(recorder)
	}
	day := formatCivil(eventDay(date))
	return mcpToolSuccess(map[string]any{
		"deleted":       true,
		"inspectionId":  *id,
		"hiveId":        hiveID,
		"positionLabel": label,
		"date":          day,
		"message":       fmt.Sprintf("Deleted the %s inspection of hive %s", day, label),
	}), nil
}

func (s *Server) mcpRecordFeeding(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	hiveID, err := mcpUUID(args, "hiveId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawDate, err := mcpRequiredString(args, "dateFed")
	if err != nil {
		return mcpToolResult{}, err
	}
	_, day, err := mcpDay(rawDate, "dateFed")
	if err != nil {
		return mcpToolResult{}, err
	}
	feedType, err := mcpRequiredString(args, "type")
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireHive(r, *hiveID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeFeeding, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateFeeding(r.Context(), s.pool, *hiveID, day, feedType)
		},
		func() (mcpToolResult, error) {
			return s.mcpCallJSONHandler(r, args, s.handleFeedingCreate)
		})
}

func (s *Server) mcpRecordMiteCount(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	hiveID, err := mcpUUID(args, "hiveId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawDate, err := mcpRequiredString(args, "date")
	if err != nil {
		return mcpToolResult{}, err
	}
	_, day, err := mcpDay(rawDate, "date")
	if err != nil {
		return mcpToolResult{}, err
	}
	method, err := mcpRequiredString(args, "method")
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireHive(r, *hiveID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeMiteCount, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateMiteCount(r.Context(), s.pool, *hiveID, day, method)
		},
		func() (mcpToolResult, error) {
			return s.mcpCallJSONHandler(r, args, s.miteCountCreate)
		})
}

// treatmentIsOneShot reports whether product resolves (by name or alias,
// case-insensitively, as resolveWithdrawalDays does) to a catalog product
// whose notes mark it one-shot. Oxalic acid is the seeded example.
func (s *Server) treatmentIsOneShot(ctx context.Context, product string) (bool, error) {
	var oneShot bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM treatment_products
			WHERE (name_key = lower(btrim($1))
			   OR EXISTS (
				SELECT 1 FROM unnest(aliases) alias
				WHERE lower(btrim(alias)) = lower(btrim($1))
			   ))
			  AND lower(COALESCE(notes, '')) ~ 'one[- ]shot'
		)`, product).Scan(&oneShot)
	return oneShot, err
}

// closeOneShotInspectionTreatments applies the record_treatment one-shot
// default to the treatment events an MCP-created inspection just wrote: an
// open oxalic treatment would otherwise lock the hive indefinitely.
func closeOneShotInspectionTreatments(ctx context.Context, q inspectionQuerier, inspectionID uuid.UUID) error {
	_, err := q.Exec(ctx, `
		UPDATE treatment_events t SET date_removed = t.date_applied
		WHERE t.inspection_id = $1 AND t.deleted_at IS NULL AND t.date_removed IS NULL
		  AND EXISTS (
			SELECT 1 FROM treatment_products p
			WHERE (p.name_key = lower(btrim(t.product))
			   OR EXISTS (
				SELECT 1 FROM unnest(p.aliases) alias
				WHERE lower(btrim(alias)) = lower(btrim(t.product))
			   ))
			  AND lower(COALESCE(p.notes, '')) ~ 'one[- ]shot'
		  )`, inspectionID)
	return err
}

func (s *Server) mcpRecordTreatment(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	hiveID, err := mcpUUID(args, "hiveId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawApplied, err := mcpRequiredString(args, "dateApplied")
	if err != nil {
		return mcpToolResult{}, err
	}
	applied, day, err := mcpDay(rawApplied, "dateApplied")
	if err != nil {
		return mcpToolResult{}, err
	}
	product, err := mcpRequiredString(args, "product")
	if err != nil {
		return mcpToolResult{}, err
	}
	rawRemoved, err := mcpString(args, "dateRemoved")
	if err != nil {
		return mcpToolResult{}, err
	}
	if rawRemoved != nil && strings.TrimSpace(*rawRemoved) != "" {
		removed, err := parseDate(*rawRemoved)
		if err != nil {
			return mcpToolResult{}, errors.New("dateRemoved must be a date (YYYY-MM-DD)")
		}
		if calendarDate(removed).Before(calendarDate(applied)) {
			return mcpToolResult{}, errors.New("dateRemoved must be on or after dateApplied")
		}
	}
	if err := s.mcpRequireHive(r, *hiveID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeTreatment, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateTreatment(r.Context(), s.pool, *hiveID, day, product)
		},
		func() (mcpToolResult, error) {
			defaulted := false
			if rawRemoved == nil || strings.TrimSpace(*rawRemoved) == "" {
				oneShot, err := s.treatmentIsOneShot(r.Context(), product)
				if err != nil {
					return mcpToolResult{}, err
				}
				if oneShot {
					args["dateRemoved"], _ = json.Marshal(rawApplied)
					defaulted = true
				}
			}
			recorder, err := mcpInvoke(r, s.treatmentEventCreate, nil, nil, args)
			if err != nil {
				return mcpToolResult{}, err
			}
			if recorder.Code < 200 || recorder.Code >= 300 {
				return mcpToolResult{}, mcpRecorderError(recorder)
			}
			var created struct {
				ID uuid.UUID `json:"id"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
				return mcpToolResult{}, err
			}
			record, err := s.treatmentRecord(r.Context(), created.ID)
			if err != nil {
				return mcpToolResult{}, err
			}
			record["dateRemovedDefaulted"] = defaulted
			return mcpToolSuccess(record), nil
		})
}

func (s *Server) mcpRecordQueenEvent(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	hiveID, err := mcpUUID(args, "hiveId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawDate, err := mcpRequiredString(args, "eventDate")
	if err != nil {
		return mcpToolResult{}, err
	}
	_, day, err := mcpDay(rawDate, "eventDate")
	if err != nil {
		return mcpToolResult{}, err
	}
	eventType, err := mcpRequiredString(args, "eventType")
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireHive(r, *hiveID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeQueenEvent, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateQueenEvent(r.Context(), s.pool, *hiveID, day, eventType)
		},
		func() (mcpToolResult, error) {
			recorder, err := mcpInvoke(r, s.queenEventCreate, nil, nil, args)
			if err != nil {
				return mcpToolResult{}, err
			}
			if recorder.Code < 200 || recorder.Code >= 300 {
				return mcpToolResult{}, mcpRecorderError(recorder)
			}
			var created struct {
				ID uuid.UUID `json:"id"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
				return mcpToolResult{}, err
			}
			record, err := s.queenEventRecord(r.Context(), created.ID)
			if err != nil {
				return mcpToolResult{}, err
			}
			return mcpToolSuccess(record), nil
		})
}

func (s *Server) mcpRecordApiaryObservation(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	apiaryID, err := mcpUUID(args, "apiaryId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawObserved, err := mcpRequiredString(args, "observedAt")
	if err != nil {
		return mcpToolResult{}, err
	}
	observedAt, err := parseDate(rawObserved)
	if err != nil {
		return mcpToolResult{}, errors.New("observedAt must be an RFC 3339 timestamp or a date")
	}
	notes, err := mcpRequiredString(args, "notes")
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireOwner(r, "apiary", *apiaryID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeApiaryObservation, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateObservation(r.Context(), s.pool, *apiaryID, observedAt, notes)
		},
		func() (mcpToolResult, error) {
			// The REST body takes a full timestamp; a date-only value has
			// already been resolved to midnight by parseDate.
			return s.mcpCallJSONHandler(r, map[string]json.RawMessage{
				"apiaryId":   args["apiaryId"],
				"observedAt": mustJSON(observedAt.Format(time.RFC3339Nano)),
				"notes":      args["notes"],
			}, s.handleApiaryInspectionCreate)
		})
}

func (s *Server) mcpRecordBloomObservation(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	allow, err := mcpPopBool(args, "allowDuplicate")
	if err != nil {
		return mcpToolResult{}, err
	}
	apiaryID, err := mcpUUID(args, "apiaryId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	species, err := mcpRequiredString(args, "species")
	if err != nil {
		return mcpToolResult{}, err
	}
	rawDate, err := mcpRequiredString(args, "dateFirstSeen")
	if err != nil {
		return mcpToolResult{}, err
	}
	_, day, err := mcpDay(rawDate, "dateFirstSeen")
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireApiary(r, *apiaryID, true); err != nil {
		return mcpToolResult{}, err
	}
	return s.mcpDedupeOr(r.Context(), dedupeBloomObservation, allow,
		func() (*uuid.UUID, error) {
			return findDuplicateBloom(r.Context(), s.pool, *apiaryID, day, species)
		},
		func() (mcpToolResult, error) {
			return s.mcpCallJSONHandler(r, args, s.handleBloomCreate)
		})
}

func (s *Server) mcpSetHiveStatus(r *http.Request, args map[string]json.RawMessage) (mcpToolResult, error) {
	hiveID, err := mcpUUID(args, "hiveId", true)
	if err != nil {
		return mcpToolResult{}, err
	}
	if err := s.mcpRequireHive(r, *hiveID, true); err != nil {
		return mcpToolResult{}, err
	}
	body := map[string]json.RawMessage{"status": args["status"]}
	if raw, ok := args["date"]; ok {
		body["date"] = raw
	}
	recorder, err := mcpInvoke(r, s.handleHiveStatus, hiveID, nil, body)
	if err != nil {
		return mcpToolResult{}, err
	}
	return mcpRecorderResult(recorder)
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}
