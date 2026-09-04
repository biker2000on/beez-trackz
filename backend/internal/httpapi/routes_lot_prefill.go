package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/biker2000on/beez-trackz/backend/internal/ai"
	"github.com/biker2000on/beez-trackz/backend/internal/app/production"
)

// Lot prefill and the AI beekeeper-story draft.
//
// The harvest-lot dialog names a yard, the day the frames were pulled and the
// day the honey was extracted; everything the system already knows about that
// season (bloom, elevation, region, the harvests that belong) is derived here
// so the operator does not retype it. Nothing on this file persists: the
// client puts the answers into the form and the lot commands store them.

const (
	// prefillHarvestBefore / prefillHarvestAfter bound the candidate harvest
	// list around the pull-to-extraction window.
	prefillHarvestBefore = 14 * 24 * time.Hour
	prefillHarvestAfter  = 1 * 24 * time.Hour
	// prefillSuggestSlack is how far from the pull date a harvest can be and
	// still be pre-ticked.
	prefillSuggestSlack = 3 * 24 * time.Hour
)

type lotPrefillHarvest struct {
	ID                    uuid.UUID  `json:"id"`
	HiveID                uuid.UUID  `json:"hiveId"`
	HiveName              string     `json:"hiveName"`
	SessionID             *uuid.UUID `json:"sessionId"`
	Date                  time.Time  `json:"date"`
	CalculatedHoneyWeight float64    `json:"calculatedHoneyWeight"`
	DirectWeight          bool       `json:"directWeight"`
	InLotID               *uuid.UUID `json:"inLotId"`
	Suggested             bool       `json:"suggested"`
}

type lotPrefillResponse struct {
	Season              string              `json:"season"`
	ClaimYear           int                 `json:"claimYear"`
	ApiaryRegion        *string             `json:"apiaryRegion"`
	ElevationM          *float64            `json:"elevationM"`
	BloomNotes          *string             `json:"bloomNotes"`
	SuggestedVarietalID *uuid.UUID          `json:"suggestedVarietalId"`
	Harvests            []lotPrefillHarvest `json:"harvests"`
}

// parseLotDay reads a YYYY-MM-DD query or body value as a UTC calendar day.
func parseLotDay(raw string) (time.Time, error) {
	return time.ParseInLocation("2006-01-02", strings.TrimSpace(raw), time.UTC)
}

// GET /lots/prefill?apiaryId=&pulledOn=&extractedOn=
func (s *Server) lotPrefill(w http.ResponseWriter, r *http.Request) {
	if s.pool == nil {
		writeError(w, http.StatusInternalServerError, "database unavailable")
		return
	}
	query := r.URL.Query()
	apiaryID, err := uuid.Parse(strings.TrimSpace(query.Get("apiaryId")))
	if err != nil {
		writeError(w, http.StatusBadRequest, "apiaryId must be a UUID")
		return
	}
	pulledOn, err := parseLotDay(query.Get("pulledOn"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "pulledOn must be a YYYY-MM-DD date")
		return
	}
	extractedOn := pulledOn
	if raw := strings.TrimSpace(query.Get("extractedOn")); raw != "" {
		if extractedOn, err = parseLotDay(raw); err != nil {
			writeError(w, http.StatusBadRequest, "extractedOn must be a YYYY-MM-DD date")
			return
		}
	}
	if extractedOn.Before(pulledOn) {
		writeError(w, http.StatusBadRequest, "extractedOn must not be before pulledOn")
		return
	}
	ctx := r.Context()

	var apiaryName string
	var elevation *float64
	if err := s.pool.QueryRow(ctx, `SELECT name, elevation_m FROM apiaries WHERE id=$1`, apiaryID).Scan(&apiaryName, &elevation); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "apiary not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	out := lotPrefillResponse{
		Season:     production.SeasonFor(extractedOn),
		ClaimYear:  pulledOn.Year(),
		ElevationM: elevation,
		Harvests:   []lotPrefillHarvest{},
	}

	// Region carries forward from the newest lot that already claimed this
	// yard and named one; the operator rarely moves the yard.
	if err := s.pool.QueryRow(ctx, `
		SELECT apiary_region FROM harvest_lots
		WHERE claim_apiary_id=$1 AND btrim(COALESCE(apiary_region,'')) <> ''
		ORDER BY extraction_date DESC, created_at DESC LIMIT 1`, apiaryID).Scan(&out.ApiaryRegion); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	blooms, err := s.bloomObservationsOverlapping(ctx, apiaryID, pulledOn.Add(-production.BloomLookback), pulledOn)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	out.BloomNotes = production.FormatBloomNotes(blooms)

	// The varietal this yard gave in the same season of an earlier year,
	// else whatever it gave most recently.
	seasonName := production.SeasonName(extractedOn.Month())
	if err := s.pool.QueryRow(ctx, `
		SELECT varietal_id FROM harvest_lots
		WHERE claim_apiary_id=$1 AND varietal_id IS NOT NULL
		  AND season ~ ('^' || $2 || ' [0-9]{4}$')
		  AND substring(season from '[0-9]{4}$')::int < $3
		ORDER BY extraction_date DESC, created_at DESC LIMIT 1`,
		apiaryID, seasonName, extractedOn.Year()).Scan(&out.SuggestedVarietalID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if out.SuggestedVarietalID == nil {
		if err := s.pool.QueryRow(ctx, `
			SELECT varietal_id FROM harvest_lots
			WHERE claim_apiary_id=$1 AND varietal_id IS NOT NULL
			ORDER BY extraction_date DESC, created_at DESC LIMIT 1`, apiaryID).Scan(&out.SuggestedVarietalID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	harvests, err := s.lotCandidateHarvests(ctx, apiaryID, pulledOn, extractedOn)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	out.Harvests = harvests
	writeJSON(w, http.StatusOK, out)
}

// bloomObservationsOverlapping lists this yard's blooms whose window
// [first seen, last seen or first + 21 days] touches [from, to], oldest first.
func (s *Server) bloomObservationsOverlapping(ctx context.Context, apiaryID uuid.UUID, from, to time.Time) ([]production.BloomObservation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT species, abundance, date_first_seen, date_last_seen, notes
		FROM bloom_observations
		WHERE apiary_id=$1
		  AND date_first_seen <= $3::date
		  AND COALESCE(date_last_seen, date_first_seen + 21) >= $2::date
		ORDER BY date_first_seen, species, id`, apiaryID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []production.BloomObservation{}
	for rows.Next() {
		var bloom production.BloomObservation
		if err := rows.Scan(&bloom.Species, &bloom.Abundance, &bloom.DateFirst, &bloom.DateLast, &bloom.Notes); err != nil {
			return nil, err
		}
		out = append(out, bloom)
	}
	return out, rows.Err()
}

// lotCandidateHarvests lists every live harvest of this yard's sessions dated
// within [pulledOn - 14 days, extractedOn + 1 day], newest first, marking the
// ones already in a lot and pre-ticking those within 3 days of the pull.
func (s *Server) lotCandidateHarvests(ctx context.Context, apiaryID uuid.UUID, pulledOn, extractedOn time.Time) ([]lotPrefillHarvest, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT h.id, h.hive_id, hive.position_label, h.session_id, h.date,
			h.calculated_honey_weight, h.direct_weight,
			(SELECT link.lot_id FROM harvest_lot_harvests link WHERE link.harvest_id=h.id ORDER BY link.lot_id LIMIT 1)
		FROM honey_harvests h
		JOIN harvest_sessions session ON session.id=h.session_id
		JOIN hives hive ON hive.id=h.hive_id
		WHERE h.deleted_at IS NULL AND session.apiary_id=$1
		  AND h.date >= $2::date AND h.date < ($3::date + 1)
		ORDER BY h.date DESC, hive.position_label, h.id`,
		apiaryID, pulledOn.Add(-prefillHarvestBefore), extractedOn.Add(prefillHarvestAfter))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	suggestFrom := pulledOn.Add(-prefillSuggestSlack)
	suggestTo := pulledOn.Add(prefillSuggestSlack + 24*time.Hour)
	out := []lotPrefillHarvest{}
	for rows.Next() {
		var harvest lotPrefillHarvest
		if err := rows.Scan(&harvest.ID, &harvest.HiveID, &harvest.HiveName, &harvest.SessionID, &harvest.Date,
			&harvest.CalculatedHoneyWeight, &harvest.DirectWeight, &harvest.InLotID); err != nil {
			return nil, err
		}
		harvest.Suggested = harvest.InLotID == nil && !harvest.Date.Before(suggestFrom) && harvest.Date.Before(suggestTo)
		out = append(out, harvest)
	}
	return out, rows.Err()
}

// storyDrafterFor resolves the recommendations provider. Tests replace it
// with a fake; the default reads the stored AI settings.
func (s *Server) storyDrafterFor(ctx context.Context) (production.StoryDrafter, string, error) {
	if s.storyDrafter != nil {
		return s.storyDrafter(ctx)
	}
	cfg, err := ai.LoadConfig(ctx, s.pool)
	if err != nil {
		return nil, "", err
	}
	provider, err := ai.ProviderForTask(cfg, ai.TaskRecommendations)
	if err != nil {
		return nil, "", errNoStoryProvider
	}
	name := strings.TrimSpace(cfg.Recommendations.Provider)
	if name == "" {
		name = "claude"
	}
	return provider, name, nil
}

var errNoStoryProvider = errors.New("no AI provider configured for recommendations")

type lotStoryDraftRequest struct {
	ApiaryID    uuid.UUID   `json:"apiaryId"`
	PulledOn    string      `json:"pulledOn"`
	ExtractedOn string      `json:"extractedOn"`
	VarietalID  *uuid.UUID  `json:"varietalId"`
	HarvestIDs  []uuid.UUID `json:"harvestIds"`
}

// POST /lots/story-draft
func (s *Server) lotStoryDraft(w http.ResponseWriter, r *http.Request) {
	if s.pool == nil {
		writeError(w, http.StatusInternalServerError, "database unavailable")
		return
	}
	var req lotStoryDraftRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ApiaryID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "apiaryId is required")
		return
	}
	pulledOn, err := parseLotDay(req.PulledOn)
	if err != nil {
		writeError(w, http.StatusBadRequest, "pulledOn must be a YYYY-MM-DD date")
		return
	}
	extractedOn := pulledOn
	if strings.TrimSpace(req.ExtractedOn) != "" {
		if extractedOn, err = parseLotDay(req.ExtractedOn); err != nil {
			writeError(w, http.StatusBadRequest, "extractedOn must be a YYYY-MM-DD date")
			return
		}
	}
	if extractedOn.Before(pulledOn) {
		writeError(w, http.StatusBadRequest, "extractedOn must not be before pulledOn")
		return
	}
	ctx := r.Context()

	drafter, providerName, err := s.storyDrafterFor(ctx)
	if err != nil {
		if errors.Is(err, errNoStoryProvider) {
			writeError(w, http.StatusServiceUnavailable, errNoStoryProvider.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	sc, err := s.gatherStoryContext(ctx, req, pulledOn, extractedOn)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "apiary not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	story, sources, err := production.DraftStory(ctx, drafter, sc)
	if err != nil {
		writeError(w, http.StatusBadGateway, "the AI provider could not draft the story: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"story": story, "provider": providerName, "sources": sources,
	})
}

// gatherStoryContext reads the season's records for the yard: inspections
// from January 1 of the pull year through the extraction day, the harvests
// (the named ones, else the lot window's), and every bloom overlapping the
// season. apiary_weather_cache is a single forecast blob per yard with an
// expiry, not a history, so weather is not read.
func (s *Server) gatherStoryContext(ctx context.Context, req lotStoryDraftRequest, pulledOn, extractedOn time.Time) (production.StoryContext, error) {
	sc := production.StoryContext{PulledOn: pulledOn, ExtractedOn: extractedOn}
	if err := s.pool.QueryRow(ctx, `SELECT name, elevation_m FROM apiaries WHERE id=$1`, req.ApiaryID).Scan(&sc.ApiaryName, &sc.ElevationM); err != nil {
		return sc, err
	}
	if req.VarietalID != nil {
		var name string
		err := s.pool.QueryRow(ctx, `SELECT name FROM honey_varietals WHERE id=$1`, *req.VarietalID).Scan(&name)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return sc, err
		}
		if err == nil {
			sc.VarietalName = &name
		}
	}
	seasonStart := time.Date(pulledOn.Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
	seasonEnd := extractedOn.Add(24 * time.Hour)

	rows, err := s.pool.Query(ctx, `
		SELECT i.date, hive.position_label, i.queen_seen, i.brood_pattern, i.stores_honey,
			i.stores_pollen, i.temperament, i.flow_on, i.notes
		FROM inspections i
		JOIN hives hive ON hive.id=i.hive_id
		WHERE hive.apiary_id=$1 AND i.date >= $2::date AND i.date < $3::date
		ORDER BY i.date, hive.position_label`, req.ApiaryID, seasonStart, seasonEnd)
	if err != nil {
		return sc, err
	}
	for rows.Next() {
		var inspection production.StoryInspection
		if err := rows.Scan(&inspection.Date, &inspection.HiveName, &inspection.QueenSeen, &inspection.BroodPattern,
			&inspection.StoresHoney, &inspection.StoresPollen, &inspection.Temperament, &inspection.FlowOn, &inspection.Notes); err != nil {
			rows.Close()
			return sc, err
		}
		sc.Inspections = append(sc.Inspections, inspection)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return sc, err
	}

	harvestWhere := `session.apiary_id=$1 AND h.date >= $2::date AND h.date < ($3::date + 1)`
	harvestArgs := []any{req.ApiaryID, pulledOn.Add(-prefillHarvestBefore), extractedOn.Add(prefillHarvestAfter)}
	if len(req.HarvestIDs) > 0 {
		harvestWhere = `h.id = ANY($1)`
		harvestArgs = []any{req.HarvestIDs}
	}
	rows, err = s.pool.Query(ctx, `
		SELECT h.date, hive.position_label, h.calculated_honey_weight, h.notes, session.notes
		FROM honey_harvests h
		JOIN hives hive ON hive.id=h.hive_id
		LEFT JOIN harvest_sessions session ON session.id=h.session_id
		WHERE h.deleted_at IS NULL AND `+harvestWhere+`
		ORDER BY h.date, hive.position_label`, harvestArgs...)
	if err != nil {
		return sc, err
	}
	for rows.Next() {
		var harvest production.StoryHarvest
		if err := rows.Scan(&harvest.Date, &harvest.HiveName, &harvest.Pounds, &harvest.Notes, &harvest.SessionNotes); err != nil {
			rows.Close()
			return sc, err
		}
		sc.Harvests = append(sc.Harvests, harvest)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return sc, err
	}

	blooms, err := s.bloomObservationsOverlapping(ctx, req.ApiaryID, seasonStart, extractedOn)
	if err != nil {
		return sc, err
	}
	sc.Blooms = blooms
	return sc, nil
}
