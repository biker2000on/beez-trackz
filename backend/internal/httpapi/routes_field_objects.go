package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/biker2000on/beez-trackz/backend/internal/recs"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// mountFieldObjects is intentionally a separate domain block. The integration
// point is one s.mountFieldObjects(r) call in mountDomains.
func (s *Server) mountFieldObjects(r chi.Router) {
	r.Get("/field/readiness", s.fieldReadinessList)
	r.Get("/field/autopsy-summary", s.deadoutAutopsySummary)
	r.Get("/catch-boxes", s.catchBoxList)
	r.Post("/catch-boxes", s.catchBoxCreate)
	r.Patch("/catch-boxes/{id}/occupancy", s.catchBoxSetOccupancy)
	r.Delete("/catch-boxes/{id}", s.catchBoxDelete)
	r.Get("/colony-intakes", s.colonyIntakeList)
	r.Post("/colony-intakes", s.colonyIntakeCreate)
	r.Get("/incidents", s.incidentList)
	r.Post("/incidents", s.incidentCreate)
	r.Delete("/incidents/{id}", s.incidentDelete)
	r.With(s.requireHiveParamRole(false)).Get("/hives/{id}/autopsy", s.deadoutAutopsyGet)
	r.With(s.requireHiveParamRole(true)).Put("/hives/{id}/autopsy", s.deadoutAutopsyPut)
}

func fieldValidIncident(v string) bool {
	switch v {
	case "robbing", "yellowjackets", "bears", "skunks", "flood":
		return true
	}
	return false
}

func fieldValidIntakeSource(v string) bool {
	switch v {
	case "package", "nuc", "split", "swarm", "catch_box", "other":
		return true
	}
	return false
}

func fieldValidLocation(v string) bool {
	switch v {
	case "yard", "stand", "fence_line":
		return true
	}
	return false
}

func (s *Server) fieldReadinessList(w http.ResponseWriter, r *http.Request) {
	items, err := recs.SwarmSplitReadiness(r.Context(), s.pool, time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	user := principalFrom(r)
	if user != nil && !user.IsAdmin {
		visible := items[:0]
		for _, item := range items {
			apiaryID, err := uuid.Parse(item.ApiaryID)
			if err != nil {
				continue
			}
			if _, err := s.apiaryRole(r, apiaryID); err == nil {
				visible = append(visible, item)
			}
		}
		items = visible
	}
	writeJSON(w, http.StatusOK, items)
}

type catchBoxJSON struct {
	ID             uuid.UUID  `json:"id"`
	ApiaryID       uuid.UUID  `json:"apiaryId"`
	ApiaryName     string     `json:"apiaryName"`
	LocationKind   string     `json:"locationKind"`
	StandID        *string    `json:"standId"`
	FenceLine      *string    `json:"fenceLine"`
	DateSet        time.Time  `json:"dateSet"`
	EmptyAsOf      *time.Time `json:"emptyAsOf"`
	Occupied       bool       `json:"occupied"`
	OccupiedAt     *time.Time `json:"occupiedAt"`
	OccupiedHiveID *uuid.UUID `json:"occupiedHiveId"`
	Notes          *string    `json:"notes"`
}

func (s *Server) catchBoxList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT c.id,c.apiary_id,a.name,c.location_kind,c.stand_id,c.fence_line,
		       c.date_set,c.empty_as_of,c.occupied,c.occupied_at,c.occupied_hive_id,c.notes
		FROM catch_boxes c JOIN apiaries a ON a.id=c.apiary_id
		WHERE c.deleted_at IS NULL AND ($1::boolean OR EXISTS (
		 SELECT 1 FROM apiary_memberships m WHERE m.apiary_id=c.apiary_id AND m.user_id=$2))
		ORDER BY c.occupied, c.date_set DESC`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()
	out := []catchBoxJSON{}
	for rows.Next() {
		var v catchBoxJSON
		if err := rows.Scan(&v.ID, &v.ApiaryID, &v.ApiaryName, &v.LocationKind, &v.StandID, &v.FenceLine, &v.DateSet, &v.EmptyAsOf, &v.Occupied, &v.OccupiedAt, &v.OccupiedHiveID, &v.Notes); err != nil {
			writeError(w, 500, "database error")
			return
		}
		out = append(out, v)
	}
	if rows.Err() != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) catchBoxCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID     uuid.UUID `json:"apiaryId"`
		LocationKind string    `json:"locationKind"`
		StandID      *string   `json:"standId"`
		FenceLine    *string   `json:"fenceLine"`
		DateSet      string    `json:"dateSet"`
		EmptyAsOf    *string   `json:"emptyAsOf"`
		Notes        *string   `json:"notes"`
	}
	if decodeJSON(r, &req) != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	if req.ApiaryID == uuid.Nil || !fieldValidLocation(req.LocationKind) {
		writeError(w, 400, "apiaryId and valid locationKind are required")
		return
	}
	if !s.requireApiaryRole(w, r, req.ApiaryID, true) {
		return
	}
	date, err := parseDate(req.DateSet)
	if err != nil {
		writeError(w, 400, "invalid dateSet")
		return
	}
	empty, err := parseDatePtr(req.EmptyAsOf)
	if err != nil {
		writeError(w, 400, "invalid emptyAsOf")
		return
	}
	stand, fence := hiveTextOrNil(req.StandID), hiveTextOrNil(req.FenceLine)
	if req.LocationKind == "stand" && stand == nil || req.LocationKind == "fence_line" && fence == nil {
		writeError(w, 400, "selected location detail is required")
		return
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `INSERT INTO catch_boxes (apiary_id,location_kind,stand_id,fence_line,date_set,empty_as_of,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, req.ApiaryID, req.LocationKind, stand, fence, date, empty, hiveTextOrNil(req.Notes), actorID(r)).Scan(&id)
	if err != nil {
		writeError(w, 400, "invalid catch box")
		return
	}
	writeJSON(w, 201, map[string]any{"id": id})
}

func (s *Server) catchBoxSetOccupancy(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var apiaryID uuid.UUID
	if err = s.pool.QueryRow(r.Context(), `SELECT apiary_id FROM catch_boxes WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&apiaryID); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "catch box not found")
		return
	} else if err != nil {
		writeError(w, 500, "database error")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	var req struct {
		Occupied       bool       `json:"occupied"`
		OccupiedAt     *string    `json:"occupiedAt"`
		OccupiedHiveID *uuid.UUID `json:"occupiedHiveId"`
		EmptyAsOf      *string    `json:"emptyAsOf"`
	}
	if decodeJSON(r, &req) != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	occupiedAt, err := parseDatePtr(req.OccupiedAt)
	if err != nil {
		writeError(w, 400, "invalid occupiedAt")
		return
	}
	empty, err := parseDatePtr(req.EmptyAsOf)
	if err != nil {
		writeError(w, 400, "invalid emptyAsOf")
		return
	}
	if req.Occupied && occupiedAt == nil {
		writeError(w, 400, "occupiedAt is required when occupied")
		return
	}
	if !req.Occupied {
		occupiedAt = nil
		req.OccupiedHiveID = nil
	}
	if req.OccupiedHiveID != nil {
		// The hive must live in the catch box's own yard: the caller's editor
		// role was checked against that yard only, so accepting a foreign
		// hive UUID would let them attach a hive they cannot even view.
		var hiveApiary uuid.UUID
		if err := s.pool.QueryRow(r.Context(), `
			SELECT apiary_id FROM hives WHERE id=$1`, *req.OccupiedHiveID).Scan(&hiveApiary); err != nil {
			writeError(w, 400, "invalid occupiedHiveId")
			return
		}
		if hiveApiary != apiaryID {
			writeError(w, 400, "occupiedHiveId must be a hive in the catch box's yard")
			return
		}
	}
	_, err = s.pool.Exec(r.Context(), `UPDATE catch_boxes SET occupied=$2,occupied_at=$3,occupied_hive_id=$4,empty_as_of=$5 WHERE id=$1`, id, req.Occupied, occupiedAt, req.OccupiedHiveID, empty)
	if err != nil {
		writeError(w, 400, "invalid occupancy")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func (s *Server) catchBoxDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var apiaryID uuid.UUID
	if err = s.pool.QueryRow(r.Context(), `SELECT apiary_id FROM catch_boxes WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&apiaryID); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "catch box not found")
		return
	} else if err != nil {
		writeError(w, 500, "database error")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)
	_, err = s.pool.Exec(r.Context(), `UPDATE catch_boxes SET deleted_at=now(),deleted_by=$2,deletion_reason=$3 WHERE id=$1`, id, actorID(r), hiveTextOrNil(req.Reason))
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

type colonyIntakeJSON struct {
	ID             uuid.UUID  `json:"id"`
	HiveID         uuid.UUID  `json:"hiveId"`
	HiveName       string     `json:"hiveName"`
	ApiaryID       uuid.UUID  `json:"apiaryId"`
	ApiaryName     string     `json:"apiaryName"`
	Source         string     `json:"source"`
	SourceDetail   *string    `json:"sourceDetail"`
	IntakeDate     time.Time  `json:"intakeDate"`
	StartingStores *string    `json:"startingStores"`
	Cost           money      `json:"cost"`
	QueenID        *uuid.UUID `json:"queenId"`
	CohortYear     int        `json:"cohortYear"`
	Notes          *string    `json:"notes"`
}

func (s *Server) colonyIntakeList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `SELECT i.id,i.hive_id,h.position_label,i.apiary_id,a.name,i.source,i.source_detail,i.intake_date,i.starting_stores,i.cost_cents,i.queen_id,i.cohort_year,i.notes FROM colony_intakes i JOIN hives h ON h.id=i.hive_id JOIN apiaries a ON a.id=i.apiary_id WHERE $1::boolean OR EXISTS (SELECT 1 FROM apiary_memberships m WHERE m.apiary_id=i.apiary_id AND m.user_id=$2) ORDER BY i.intake_date DESC`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()
	out := []colonyIntakeJSON{}
	for rows.Next() {
		var v colonyIntakeJSON
		if rows.Scan(&v.ID, &v.HiveID, &v.HiveName, &v.ApiaryID, &v.ApiaryName, &v.Source, &v.SourceDetail, &v.IntakeDate, &v.StartingStores, &v.Cost, &v.QueenID, &v.CohortYear, &v.Notes) != nil {
			writeError(w, 500, "database error")
			return
		}
		out = append(out, v)
	}
	if rows.Err() != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) colonyIntakeCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ApiaryID       uuid.UUID  `json:"apiaryId"`
		PositionLabel  string     `json:"positionLabel"`
		Source         string     `json:"source"`
		SourceDetail   *string    `json:"sourceDetail"`
		SourceHiveID   *uuid.UUID `json:"sourceHiveId"`
		CatchBoxID     *uuid.UUID `json:"catchBoxId"`
		IntakeDate     string     `json:"intakeDate"`
		StartingStores *string    `json:"startingStores"`
		Cost           money      `json:"cost"`
		ParentQueenID  *uuid.UUID `json:"parentQueenId"`
		Notes          *string    `json:"notes"`
	}
	if decodeJSON(r, &req) != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	label := strings.TrimSpace(req.PositionLabel)
	if req.ApiaryID == uuid.Nil || label == "" || !fieldValidIntakeSource(req.Source) || req.Cost < 0 {
		writeError(w, 400, "apiary, position, source, date, and non-negative cost are required")
		return
	}
	date, err := parseDate(req.IntakeDate)
	if err != nil {
		writeError(w, 400, "invalid intakeDate")
		return
	}
	if !s.requireApiaryRole(w, r, req.ApiaryID, true) {
		return
	}
	if req.SourceHiveID != nil && !s.requireHiveRole(w, r, *req.SourceHiveID, true) {
		return
	}
	if req.ParentQueenID != nil {
		var parentApiaryID uuid.UUID
		err := s.pool.QueryRow(r.Context(), `
			SELECT h.apiary_id FROM queens q
			JOIN hives h ON h.id=COALESCE(q.hive_id,q.origin_hive_id)
			WHERE q.id=$1`, *req.ParentQueenID).Scan(&parentApiaryID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 400, "parent queen must belong to the selected apiary")
			return
		}
		if err != nil {
			writeError(w, 500, "database error")
			return
		}
		if parentApiaryID != req.ApiaryID {
			writeError(w, 400, "parent queen must belong to the selected apiary")
			return
		}
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer tx.Rollback(ctx)
	var hiveID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO hives (apiary_id,position_label,status,installed_date,notes) VALUES ($1,$2,'active',$3,$4) RETURNING id`, req.ApiaryID, label, date, hiveTextOrNil(req.Notes)).Scan(&hiveID); err != nil {
		writeError(w, 400, "invalid hive intake")
		return
	}
	if _, err = tx.Exec(ctx, `INSERT INTO hive_location_history (hive_id,apiary_id,position_label,date_from) VALUES ($1,$2,$3,$4)`, hiveID, req.ApiaryID, label, date); err != nil {
		writeError(w, 500, "database error")
		return
	}
	queenOrigin := "purchased"
	if req.Source == "swarm" || req.Source == "catch_box" {
		queenOrigin = "swarm"
	} else if req.Source == "split" {
		queenOrigin = "raised"
	}
	var queenID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO queens (hive_id,origin,origin_hive_id,parent_queen_id,introduced_date,status,notes) VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id`, hiveID, queenOrigin, req.SourceHiveID, req.ParentQueenID, date, hiveTextOrNil(req.SourceDetail)).Scan(&queenID); err != nil {
		writeError(w, 400, "invalid queen lineage")
		return
	}
	var expenseID uuid.UUID
	description := fmt.Sprintf("%s colony intake: %s", strings.ReplaceAll(req.Source, "_", " "), label)
	if err = tx.QueryRow(ctx, `INSERT INTO expenses (expense_date,category,description,amount_cents,apiary_id,hive_id,season,vendor,notes,created_by) VALUES ($1,'bees_queens',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, date, description, req.Cost, req.ApiaryID, hiveID, fmt.Sprintf("%d", date.Year()), hiveTextOrNil(req.SourceDetail), hiveTextOrNil(req.Notes), actorID(r)).Scan(&expenseID); err != nil {
		writeError(w, 500, "database error")
		return
	}
	var intakeID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO colony_intakes (hive_id,apiary_id,source,source_detail,source_hive_id,catch_box_id,intake_date,starting_stores,cost_cents,expense_id,queen_id,cohort_year,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, hiveID, req.ApiaryID, req.Source, hiveTextOrNil(req.SourceDetail), req.SourceHiveID, req.CatchBoxID, date, hiveTextOrNil(req.StartingStores), req.Cost, expenseID, queenID, date.Year(), hiveTextOrNil(req.Notes), actorID(r)).Scan(&intakeID); err != nil {
		writeError(w, 400, "invalid colony intake")
		return
	}
	if req.Source == "split" && req.SourceHiveID != nil {
		if _, err = tx.Exec(ctx, `INSERT INTO hive_splits (parent_hive_id,child_hive_id,split_date,split_type,notes) VALUES ($1,$2,$3,'other',$4)`, req.SourceHiveID, hiveID, date, hiveTextOrNil(req.Notes)); err != nil {
			writeError(w, 500, "database error")
			return
		}
	}
	if req.CatchBoxID != nil {
		tag, updateErr := tx.Exec(ctx, `UPDATE catch_boxes SET occupied=true,occupied_at=$2,occupied_hive_id=$3 WHERE id=$1 AND apiary_id=$4 AND deleted_at IS NULL`, req.CatchBoxID, date, hiveID, req.ApiaryID)
		if updateErr != nil {
			writeError(w, 500, "database error")
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, 400, "catch box must belong to the selected apiary")
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 201, map[string]any{"id": intakeID, "hiveId": hiveID, "queenId": queenID, "expenseId": expenseID})
}

type incidentJSON struct {
	ID           uuid.UUID  `json:"id"`
	IncidentType string     `json:"incidentType"`
	IncidentDate time.Time  `json:"incidentDate"`
	ApiaryID     uuid.UUID  `json:"apiaryId"`
	ApiaryName   string     `json:"apiaryName"`
	HiveID       *uuid.UUID `json:"hiveId"`
	HiveName     *string    `json:"hiveName"`
	Notes        *string    `json:"notes"`
}

func (s *Server) incidentList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `SELECT i.id,i.incident_type,i.incident_date,i.apiary_id,a.name,i.hive_id,h.position_label,i.notes FROM field_incidents i JOIN apiaries a ON a.id=i.apiary_id LEFT JOIN hives h ON h.id=i.hive_id WHERE i.deleted_at IS NULL AND ($1::boolean OR EXISTS (SELECT 1 FROM apiary_memberships m WHERE m.apiary_id=i.apiary_id AND m.user_id=$2)) ORDER BY i.incident_date DESC`, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()
	out := []incidentJSON{}
	for rows.Next() {
		var v incidentJSON
		if rows.Scan(&v.ID, &v.IncidentType, &v.IncidentDate, &v.ApiaryID, &v.ApiaryName, &v.HiveID, &v.HiveName, &v.Notes) != nil {
			writeError(w, 500, "database error")
			return
		}
		out = append(out, v)
	}
	if rows.Err() != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) incidentCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IncidentType string     `json:"incidentType"`
		IncidentDate string     `json:"incidentDate"`
		ApiaryID     uuid.UUID  `json:"apiaryId"`
		HiveID       *uuid.UUID `json:"hiveId"`
		Notes        *string    `json:"notes"`
	}
	if decodeJSON(r, &req) != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	date, err := parseDate(req.IncidentDate)
	if err != nil || req.ApiaryID == uuid.Nil || !fieldValidIncident(req.IncidentType) {
		writeError(w, 400, "date, apiary, and valid incident type are required")
		return
	}
	if !s.requireApiaryRole(w, r, req.ApiaryID, true) {
		return
	}
	if req.HiveID != nil {
		var hiveApiary uuid.UUID
		if err = s.pool.QueryRow(r.Context(), `SELECT apiary_id FROM hives WHERE id=$1`, req.HiveID).Scan(&hiveApiary); err != nil || hiveApiary != req.ApiaryID {
			writeError(w, 400, "hive must belong to the selected apiary")
			return
		}
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `INSERT INTO field_incidents (incident_type,incident_date,apiary_id,hive_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, req.IncidentType, date, req.ApiaryID, req.HiveID, hiveTextOrNil(req.Notes), actorID(r)).Scan(&id)
	if err != nil {
		writeError(w, 400, "invalid incident")
		return
	}
	writeJSON(w, 201, map[string]any{"id": id})
}

func (s *Server) incidentDelete(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var apiaryID uuid.UUID
	if err = s.pool.QueryRow(r.Context(), `SELECT apiary_id FROM field_incidents WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&apiaryID); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "incident not found")
		return
	} else if err != nil {
		writeError(w, 500, "database error")
		return
	}
	if !s.requireApiaryRole(w, r, apiaryID, true) {
		return
	}
	var req struct {
		Reason *string `json:"reason"`
	}
	_ = decodeJSON(r, &req)
	_, err = s.pool.Exec(r.Context(), `UPDATE field_incidents SET deleted_at=now(),deleted_by=$2,deletion_reason=$3 WHERE id=$1`, id, actorID(r), hiveTextOrNil(req.Reason))
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

type autopsyJSON struct {
	ID               uuid.UUID `json:"id"`
	HiveID           uuid.UUID `json:"hiveId"`
	AutopsyDate      time.Time `json:"autopsyDate"`
	StoresLeft       *string   `json:"storesLeft"`
	ClusterPosition  *string   `json:"clusterPosition"`
	LastFallMiteLoad *float64  `json:"lastFallMiteLoad"`
	QueenStatus      *string   `json:"queenStatus"`
	Moisture         *bool     `json:"moisture"`
	Mold             *bool     `json:"mold"`
	Notes            *string   `json:"notes"`
}

func scanAutopsy(row pgx.Row) (autopsyJSON, error) {
	var v autopsyJSON
	err := row.Scan(&v.ID, &v.HiveID, &v.AutopsyDate, &v.StoresLeft, &v.ClusterPosition, &v.LastFallMiteLoad, &v.QueenStatus, &v.Moisture, &v.Mold, &v.Notes)
	return v, err
}
func (s *Server) deadoutAutopsyGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	v, err := scanAutopsy(s.pool.QueryRow(r.Context(), `SELECT id,hive_id,autopsy_date,stores_left,cluster_position,last_fall_mite_load,queen_status,moisture,mold,notes FROM deadout_autopsies WHERE hive_id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "autopsy not found")
		return
	}
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, v)
}
func (s *Server) deadoutAutopsyPut(w http.ResponseWriter, r *http.Request) {
	hiveID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var req struct {
		AutopsyDate      string   `json:"autopsyDate"`
		StoresLeft       *string  `json:"storesLeft"`
		ClusterPosition  *string  `json:"clusterPosition"`
		LastFallMiteLoad *float64 `json:"lastFallMiteLoad"`
		QueenStatus      *string  `json:"queenStatus"`
		Moisture         *bool    `json:"moisture"`
		Mold             *bool    `json:"mold"`
		Notes            *string  `json:"notes"`
	}
	if decodeJSON(r, &req) != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	date, err := parseDate(req.AutopsyDate)
	if err != nil {
		writeError(w, 400, "invalid autopsyDate")
		return
	}
	if req.LastFallMiteLoad != nil && *req.LastFallMiteLoad < 0 {
		writeError(w, 400, "lastFallMiteLoad cannot be negative")
		return
	}
	if req.QueenStatus != nil && *req.QueenStatus != "present" && *req.QueenStatus != "absent" && *req.QueenStatus != "unknown" {
		writeError(w, 400, "invalid queenStatus")
		return
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO deadout_autopsies (hive_id,autopsy_date,stores_left,cluster_position,last_fall_mite_load,queen_status,moisture,mold,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (hive_id) DO UPDATE SET autopsy_date=EXCLUDED.autopsy_date,stores_left=EXCLUDED.stores_left,cluster_position=EXCLUDED.cluster_position,last_fall_mite_load=EXCLUDED.last_fall_mite_load,queen_status=EXCLUDED.queen_status,moisture=EXCLUDED.moisture,mold=EXCLUDED.mold,notes=EXCLUDED.notes RETURNING id`, hiveID, date, hiveTextOrNil(req.StoresLeft), hiveTextOrNil(req.ClusterPosition), req.LastFallMiteLoad, hiveTextOrNil(req.QueenStatus), req.Moisture, req.Mold, hiveTextOrNil(req.Notes), actorID(r)).Scan(&id)
	if err != nil {
		writeError(w, 400, "invalid autopsy")
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE hives SET status='dead',is_archived=true,deadout_date=$2 WHERE id=$1`, hiveID, date); err != nil {
		writeError(w, 500, "database error")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		writeError(w, 500, "database error")
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "success": true})
}

func (s *Server) deadoutAutopsySummary(w http.ResponseWriter, r *http.Request) {
	year := time.Now().Year()
	if raw := r.URL.Query().Get("year"); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &year); err != nil || year < 1900 || year > 2200 {
			writeError(w, 400, "invalid year")
			return
		}
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT COALESCE(a.stores_left,'Not recorded'), COALESCE(a.cluster_position,'Not recorded'),
		       COALESCE(a.queen_status,'unknown'), COALESCE(a.moisture,false), COALESCE(a.mold,false)
		FROM deadout_autopsies a JOIN hives h ON h.id=a.hive_id
		WHERE EXTRACT(YEAR FROM h.deadout_date)=$1
		  AND ($2::boolean OR EXISTS (SELECT 1 FROM apiary_memberships m
		       WHERE m.apiary_id=h.apiary_id AND m.user_id=$3))`,
		year, principalFrom(r).IsAdmin, principalFrom(r).ID)
	if err != nil {
		writeError(w, 500, "database error")
		return
	}
	defer rows.Close()
	type group struct {
		Label string `json:"label"`
		Count int    `json:"count"`
	}
	stores, clusters, queens := map[string]int{}, map[string]int{}, map[string]int{}
	total, moisture, mold := 0, 0, 0
	for rows.Next() {
		var st, cl, q string
		var wet, moldy bool
		if rows.Scan(&st, &cl, &q, &wet, &moldy) != nil {
			writeError(w, 500, "database error")
			return
		}
		total++
		stores[st]++
		clusters[cl]++
		queens[q]++
		if wet {
			moisture++
		}
		if moldy {
			mold++
		}
	}
	toGroups := func(values map[string]int) []group {
		out := make([]group, 0, len(values))
		for label, count := range values {
			out = append(out, group{label, count})
		}
		return out
	}
	writeJSON(w, 200, map[string]any{"year": year, "total": total, "moisture": moisture, "mold": mold, "stores": toGroups(stores), "clusterPositions": toGroups(clusters), "queenStatuses": toGroups(queens)})
}
