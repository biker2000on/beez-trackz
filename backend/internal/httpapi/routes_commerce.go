package httpapi

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	qrcode "github.com/skip2/go-qrcode"
)

func (s *Server) mountCommerce(r chi.Router) {
	admin := r.With(s.requireAdmin)
	admin.Get("/harvest-lots", s.harvestLotList)
	admin.Post("/harvest-lots", s.harvestLotCreate)
	admin.Get("/harvest-lots/{id}", s.harvestLotGet)
	admin.Patch("/harvest-lots/{id}", s.harvestLotUpdate)
	admin.Post("/harvest-lots/{id}/bottling-runs", s.bottlingRunCreate)
	admin.Get("/harvest-lots/{id}/qr", s.harvestLotQR)

	admin.Get("/expenses", s.expenseList)
	admin.Post("/expenses", s.expenseCreate)
	admin.Delete("/expenses/{id}", s.expenseDelete)
	admin.Get("/customers", s.customerList)
	admin.Post("/customers", s.customerCreate)
	admin.Patch("/customers/{id}", s.customerUpdate)
	admin.Get("/wholesale-price-lists", s.priceListList)
	admin.Post("/wholesale-price-lists", s.priceListCreate)

	admin.Get("/analytics/profitability", s.profitabilityAnalytics)
	admin.Get("/analytics/economics", s.economicsAnalytics)
	admin.Get("/honey/production-plan", s.productionPlan)
	admin.Get("/honey/low-stock", s.lowStockAlerts)
	admin.Get("/market-day/reconciliation", s.marketDayReconciliation)
	admin.Get("/honey/sales/{id}/receipt", s.saleReceipt)
}

func (s *Server) mountPublicCommerce(r chi.Router) {
	r.Get("/public/honey-stories/{slug}", s.publicHoneyStory)
	r.Get("/public/honey-stories/{slug}/qr", s.publicHoneyStoryQR)
	r.Get("/public/honey-stories/{slug}/photos/{photoId}", s.publicHoneyStoryPhoto)
	r.Post("/public/honey-stories/{slug}/subscribe", s.publicHoneyStorySubscribe)
}

var slugCleaner = regexp.MustCompile(`[^a-z0-9]+`)

func commerceSlug(value string) string {
	slug := strings.Trim(slugCleaner.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
	if slug == "" {
		return uuid.NewString()
	}
	return slug
}

func commerceOptionalHTTPURL(value *string) (*string, error) {
	trimmed := honeyTrimPtr(value)
	if trimmed == nil {
		return nil, nil
	}
	parsed, err := url.ParseRequestURI(*trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("URL must use http or https")
	}
	return trimmed, nil
}

type harvestLotPayload struct {
	LotCode        string         `json:"lotCode"`
	PublicSlug     string         `json:"publicSlug"`
	ExtractionDate string         `json:"extractionDate"`
	HoneyWeightLbs float64        `json:"honeyWeightLbs"`
	HoneyVariety   *string        `json:"honeyVariety"`
	Season         *string        `json:"season"`
	ApiaryRegion   *string        `json:"apiaryRegion"`
	BloomNotes     *string        `json:"bloomNotes"`
	BeekeeperStory *string        `json:"beekeeperStory"`
	TestingData    map[string]any `json:"testingData"`
	ReorderURL     *string        `json:"reorderUrl"`
	IsPublic       *bool          `json:"isPublic"`
	HarvestIDs     []uuid.UUID    `json:"harvestIds"`
	PhotoIDs       []uuid.UUID    `json:"photoIds"`
}

type harvestLotRow struct {
	ID               uuid.UUID        `json:"id"`
	LotCode          string           `json:"lotCode"`
	PublicSlug       string           `json:"publicSlug"`
	ExtractionDate   time.Time        `json:"extractionDate"`
	HoneyWeightLbs   float64          `json:"honeyWeightLbs"`
	HoneyVariety     *string          `json:"honeyVariety"`
	Season           *string          `json:"season"`
	ApiaryRegion     *string          `json:"apiaryRegion"`
	BloomNotes       *string          `json:"bloomNotes"`
	BeekeeperStory   *string          `json:"beekeeperStory"`
	TestingData      map[string]any   `json:"testingData"`
	ReorderURL       *string          `json:"reorderUrl"`
	IsPublic         bool             `json:"isPublic"`
	SourceHarvestIDs []uuid.UUID      `json:"sourceHarvestIds"`
	SourceApiaries   []string         `json:"sourceApiaries"`
	Photos           []map[string]any `json:"photos"`
	BottlingRuns     []map[string]any `json:"bottlingRuns"`
	CreatedAt        time.Time        `json:"createdAt"`
	UpdatedAt        time.Time        `json:"updatedAt"`
}

const harvestLotSelect = `
	SELECT id, lot_code, public_slug, extraction_date, honey_weight_lbs,
		honey_variety, season, apiary_region, bloom_notes, beekeeper_story,
		COALESCE(testing_data, '{}'::jsonb), reorder_url, is_public, created_at, updated_at
	FROM harvest_lots`

func (s *Server) harvestLotRows(r *http.Request, where string, args ...any) ([]harvestLotRow, error) {
	rows, err := s.pool.Query(r.Context(), harvestLotSelect+" "+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]harvestLotRow, 0)
	for rows.Next() {
		var item harvestLotRow
		if err := rows.Scan(&item.ID, &item.LotCode, &item.PublicSlug, &item.ExtractionDate,
			&item.HoneyWeightLbs, &item.HoneyVariety, &item.Season, &item.ApiaryRegion,
			&item.BloomNotes, &item.BeekeeperStory, &item.TestingData, &item.ReorderURL,
			&item.IsPublic, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.SourceHarvestIDs = []uuid.UUID{}
		item.SourceApiaries = []string{}
		item.Photos = []map[string]any{}
		item.BottlingRuns = []map[string]any{}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := s.populateHarvestLot(r, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Server) populateHarvestLot(r *http.Request, item *harvestLotRow) error {
	sourceRows, err := s.pool.Query(r.Context(), `
		SELECT hh.id, a.name
		FROM harvest_lot_harvests lhh
		JOIN honey_harvests hh ON hh.id = lhh.harvest_id
		JOIN hives h ON h.id = hh.hive_id
		JOIN apiaries a ON a.id = h.apiary_id
		WHERE lhh.lot_id = $1 ORDER BY a.name, hh.date`, item.ID)
	if err != nil {
		return err
	}
	apiarySeen := map[string]bool{}
	for sourceRows.Next() {
		var id uuid.UUID
		var apiary string
		if err := sourceRows.Scan(&id, &apiary); err != nil {
			sourceRows.Close()
			return err
		}
		item.SourceHarvestIDs = append(item.SourceHarvestIDs, id)
		if !apiarySeen[apiary] {
			item.SourceApiaries = append(item.SourceApiaries, apiary)
			apiarySeen[apiary] = true
		}
	}
	sourceRows.Close()

	photoRows, err := s.pool.Query(r.Context(), `
		SELECT p.id, '/api/v1/photos/file/' || COALESCE(p.medium_key, p.thumbnail_key, p.original_key),
			p.caption
		FROM harvest_lot_photos lp JOIN photos p ON p.id = lp.photo_id
		WHERE lp.lot_id = $1 ORDER BY lp.sort_order, p.created_at`, item.ID)
	if err != nil {
		return err
	}
	for photoRows.Next() {
		var id uuid.UUID
		var url string
		var caption *string
		if err := photoRows.Scan(&id, &url, &caption); err != nil {
			photoRows.Close()
			return err
		}
		item.Photos = append(item.Photos, map[string]any{"id": id, "url": url, "caption": caption})
	}
	photoRows.Close()

	runRows, err := s.pool.Query(r.Context(), `
		SELECT br.id, br.bottled_date, br.jar_size_id, js.label, br.quantity,
			br.honey_lbs, br.notes, COUNT(serial.id)
		FROM bottling_runs br
		LEFT JOIN jar_sizes js ON js.id = br.jar_size_id
		LEFT JOIN jar_serials serial ON serial.bottling_run_id = br.id
		WHERE br.lot_id = $1
		GROUP BY br.id, js.label ORDER BY br.bottled_date DESC`, item.ID)
	if err != nil {
		return err
	}
	for runRows.Next() {
		var id uuid.UUID
		var date time.Time
		var jarSizeID *uuid.UUID
		var label *string
		var quantity int
		var pounds *float64
		var notes *string
		var serialCount int
		if err := runRows.Scan(&id, &date, &jarSizeID, &label, &quantity, &pounds, &notes, &serialCount); err != nil {
			runRows.Close()
			return err
		}
		item.BottlingRuns = append(item.BottlingRuns, map[string]any{
			"id": id, "bottledDate": date, "jarSizeId": jarSizeID, "jarSizeLabel": label,
			"quantity": quantity, "honeyLbs": pounds, "notes": notes, "serialCount": serialCount,
		})
	}
	runRows.Close()
	return runRows.Err()
}

func (s *Server) harvestLotList(w http.ResponseWriter, r *http.Request) {
	items, err := s.harvestLotRows(r, "ORDER BY extraction_date DESC, lot_code DESC")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) harvestLotGet(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := s.harvestLotRows(r, "WHERE id = $1", id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(items) == 0 {
		writeError(w, http.StatusNotFound, "harvest lot not found")
		return
	}
	writeJSON(w, http.StatusOK, items[0])
}

func (s *Server) harvestLotCreate(w http.ResponseWriter, r *http.Request) {
	var req harvestLotPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.ExtractionDate)
	if err != nil || strings.TrimSpace(req.LotCode) == "" || req.HoneyWeightLbs < 0 {
		writeError(w, http.StatusBadRequest, "lotCode, extractionDate, and non-negative honeyWeightLbs are required")
		return
	}
	public := true
	if req.IsPublic != nil {
		public = *req.IsPublic
	}
	reorderURL, err := commerceOptionalHTTPURL(req.ReorderURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "reorderUrl must be an http or https URL")
		return
	}
	slug := commerceSlug(req.PublicSlug)
	if strings.TrimSpace(req.PublicSlug) == "" {
		slug = commerceSlug(req.LotCode)
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var id uuid.UUID
	err = tx.QueryRow(r.Context(), `
		INSERT INTO harvest_lots
			(lot_code, public_slug, extraction_date, honey_weight_lbs, honey_variety,
			 season, apiary_region, bloom_notes, beekeeper_story, testing_data,
			 reorder_url, is_public)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
		strings.TrimSpace(req.LotCode), slug, date, req.HoneyWeightLbs,
		honeyTrimPtr(req.HoneyVariety), honeyTrimPtr(req.Season),
		honeyTrimPtr(req.ApiaryRegion), honeyTrimPtr(req.BloomNotes),
		honeyTrimPtr(req.BeekeeperStory), req.TestingData,
		reorderURL, public).Scan(&id)
	if err != nil {
		writeError(w, http.StatusConflict, "lot code or public slug already exists")
		return
	}
	for _, harvestID := range req.HarvestIDs {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO harvest_lot_harvests (lot_id, harvest_id) VALUES ($1, $2)`,
			id, harvestID); err != nil {
			writeError(w, http.StatusBadRequest, "invalid harvestId")
			return
		}
	}
	for i, photoID := range req.PhotoIDs {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO harvest_lot_photos (lot_id, photo_id, sort_order) VALUES ($1, $2, $3)`,
			id, photoID, i); err != nil {
			writeError(w, http.StatusBadRequest, "invalid photoId")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "publicSlug": slug,
		"storyUrl": strings.TrimRight(s.cfg.AppURL, "/") + "/honey/" + slug,
	})
}

func (s *Server) harvestLotUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req harvestLotPayload
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.ExtractionDate)
	if err != nil || strings.TrimSpace(req.LotCode) == "" || req.HoneyWeightLbs < 0 {
		writeError(w, http.StatusBadRequest, "lotCode, extractionDate, and non-negative honeyWeightLbs are required")
		return
	}
	public := true
	if req.IsPublic != nil {
		public = *req.IsPublic
	}
	reorderURL, err := commerceOptionalHTTPURL(req.ReorderURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "reorderUrl must be an http or https URL")
		return
	}
	slug := commerceSlug(req.PublicSlug)
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `
		UPDATE harvest_lots SET lot_code=$1, public_slug=$2, extraction_date=$3,
			honey_weight_lbs=$4, honey_variety=$5, season=$6, apiary_region=$7,
			bloom_notes=$8, beekeeper_story=$9, testing_data=$10, reorder_url=$11,
			is_public=$12 WHERE id=$13`,
		strings.TrimSpace(req.LotCode), slug, date, req.HoneyWeightLbs,
		honeyTrimPtr(req.HoneyVariety), honeyTrimPtr(req.Season),
		honeyTrimPtr(req.ApiaryRegion), honeyTrimPtr(req.BloomNotes),
		honeyTrimPtr(req.BeekeeperStory), req.TestingData,
		reorderURL, public, id)
	if err != nil {
		writeError(w, http.StatusConflict, "lot code or public slug already exists")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "harvest lot not found")
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM harvest_lot_harvests WHERE lot_id=$1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM harvest_lot_photos WHERE lot_id=$1`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, harvestID := range req.HarvestIDs {
		if _, err := tx.Exec(r.Context(), `INSERT INTO harvest_lot_harvests VALUES ($1,$2)`, id, harvestID); err != nil {
			writeError(w, http.StatusBadRequest, "invalid harvestId")
			return
		}
	}
	for i, photoID := range req.PhotoIDs {
		if _, err := tx.Exec(r.Context(), `INSERT INTO harvest_lot_photos VALUES ($1,$2,$3)`, id, photoID, i); err != nil {
			writeError(w, http.StatusBadRequest, "invalid photoId")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) bottlingRunCreate(w http.ResponseWriter, r *http.Request) {
	lotID, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req struct {
		BottledDate string     `json:"bottledDate"`
		JarSizeID   *uuid.UUID `json:"jarSizeId"`
		Quantity    int        `json:"quantity"`
		HoneyLbs    *float64   `json:"honeyLbs"`
		Notes       *string    `json:"notes"`
		Serialize   bool       `json:"serialize"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.BottledDate)
	if err != nil || req.Quantity <= 0 || (req.HoneyLbs != nil && *req.HoneyLbs < 0) {
		writeError(w, http.StatusBadRequest, "bottledDate and a positive quantity are required")
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var runID uuid.UUID
	var lotCode string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO bottling_runs (lot_id, bottled_date, jar_size_id, quantity, honey_lbs, notes)
		SELECT id, $2, $3, $4, $5, $6 FROM harvest_lots WHERE id = $1
		RETURNING id`, lotID, date, req.JarSizeID, req.Quantity, req.HoneyLbs,
		honeyTrimPtr(req.Notes)).Scan(&runID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid harvest lot or jar size")
		return
	}
	if err := tx.QueryRow(r.Context(), `SELECT lot_code FROM harvest_lots WHERE id=$1`, lotID).Scan(&lotCode); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if req.JarSizeID != nil {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO honey_movements
				(date, kind, jar_size_id, quantity, amount_lbs, reason, notes)
			VALUES ($1, 'jarring', $2, $3, $4, $5, $6)`,
			date, req.JarSizeID, req.Quantity, req.HoneyLbs,
			"bottling run "+lotCode, honeyTrimPtr(req.Notes)); err != nil {
			writeError(w, http.StatusBadRequest, "invalid jar size")
			return
		}
	}
	serials := make([]string, 0)
	if req.Serialize {
		for i := 1; i <= req.Quantity; i++ {
			serial := fmt.Sprintf(
				"%s-%s-%s-%04d",
				lotCode,
				date.Format("20060102"),
				strings.ToUpper(strings.ReplaceAll(runID.String()[:6], "-", "")),
				i,
			)
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO jar_serials (bottling_run_id, serial_number) VALUES ($1,$2)`,
				runID, serial); err != nil {
				writeError(w, http.StatusConflict, "serial numbers already exist for this lot and date")
				return
			}
			serials = append(serials, serial)
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": runID, "serialNumbers": serials})
}

func (s *Server) harvestLotQR(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var slug string
	if err := s.pool.QueryRow(r.Context(), `SELECT public_slug FROM harvest_lots WHERE id=$1`, id).Scan(&slug); err != nil {
		writeError(w, http.StatusNotFound, "harvest lot not found")
		return
	}
	s.writeHoneyStoryQR(w, slug)
}

func (s *Server) publicHoneyStoryQR(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var exists bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM harvest_lots WHERE public_slug=$1 AND is_public)`, slug).Scan(&exists); err != nil || !exists {
		writeError(w, http.StatusNotFound, "honey story not found")
		return
	}
	s.writeHoneyStoryQR(w, slug)
}

func (s *Server) writeHoneyStoryQR(w http.ResponseWriter, slug string) {
	url := strings.TrimRight(s.cfg.AppURL, "/") + "/honey/" + slug
	png, err := qrcode.Encode(url, qrcode.Medium, 512)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate QR code")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

func (s *Server) publicHoneyStory(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	rows, err := s.harvestLotRows(r, "WHERE public_slug=$1 AND is_public", slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	if len(rows) == 0 {
		writeError(w, http.StatusNotFound, "honey story not found")
		return
	}
	item := rows[0]
	name := item.LotCode
	if item.HoneyVariety != nil {
		name = *item.HoneyVariety
	}
	publicPhotos := make([]map[string]any, 0, len(item.Photos))
	for _, photo := range item.Photos {
		id := fmt.Sprint(photo["id"])
		publicPhotos = append(publicPhotos, map[string]any{
			"id":      photo["id"],
			"url":     "/api/v1/public/honey-stories/" + item.PublicSlug + "/photos/" + id,
			"caption": photo["caption"],
		})
	}
	publicBottlingRuns := make([]map[string]any, 0, len(item.BottlingRuns))
	for _, run := range item.BottlingRuns {
		publicBottlingRuns = append(publicBottlingRuns, map[string]any{
			"bottledDate":  run["bottledDate"],
			"jarSizeLabel": run["jarSizeLabel"],
			"quantity":     run["quantity"],
		})
	}
	// Deliberately curated response: no hive IDs, apiary IDs, coordinates,
	// inspection data, expenses, or customer data can cross this boundary.
	writeJSON(w, http.StatusOK, map[string]any{
		"slug": item.PublicSlug, "name": name,
		"lotCode": item.LotCode, "season": item.Season,
		"description": item.BloomNotes, "floralSource": item.HoneyVariety,
		"apiaryRegion": item.ApiaryRegion, "sourceApiaries": item.SourceApiaries,
		"harvestDate": item.ExtractionDate, "harvestedPounds": item.HoneyWeightLbs,
		"beekeeperNotes": item.BeekeeperStory, "testingData": item.TestingData,
		"reorderUrl": item.ReorderURL, "photos": publicPhotos,
		"bottlingRuns": publicBottlingRuns,
	})
}

func (s *Server) publicHoneyStoryPhoto(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	photoID, err := uuid.Parse(chi.URLParam(r, "photoId"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid photoId")
		return
	}
	var key string
	err = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(p.medium_key, p.thumbnail_key, p.original_key)
		FROM harvest_lots lot
		JOIN harvest_lot_photos lp ON lp.lot_id=lot.id
		JOIN photos p ON p.id=lp.photo_id
		WHERE lot.public_slug=$1 AND lot.is_public AND p.id=$2`,
		slug, photoID).Scan(&key)
	if err != nil {
		writeError(w, http.StatusNotFound, "photo not found")
		return
	}
	s.servePhotoKey(w, r, key)
}

func (s *Server) publicHoneyStorySubscribe(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var exists bool
	if err := s.pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM harvest_lots WHERE public_slug=$1 AND is_public)`,
		slug).Scan(&exists); err != nil || !exists {
		writeError(w, http.StatusNotFound, "honey story not found")
		return
	}
	var req struct {
		Name       string  `json:"name"`
		Email      string  `json:"email"`
		ReferredBy *string `json:"referredBy"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 254 {
		writeError(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = email
	}
	if len(name) > 200 || (req.ReferredBy != nil && len(strings.TrimSpace(*req.ReferredBy)) > 200) {
		writeError(w, http.StatusBadRequest, "name or referral is too long")
		return
	}
	var id uuid.UUID
	referral := strings.ToUpper(uuid.NewString()[:8])
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO customers (name,email,email_opt_in,referral_code,referred_by)
		VALUES ($1,$2,true,$3,$4)
		ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET
			name=EXCLUDED.name, email_opt_in=true,
			referred_by=COALESCE(EXCLUDED.referred_by,customers.referred_by)
		RETURNING id`,
		name, email, referral, honeyTrimPtr(req.ReferredBy)).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not save signup")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true})
}

var expenseCategories = map[string]bool{
	"bees_queens": true, "feed": true, "treatments": true, "packaging": true,
	"equipment": true, "mileage": true, "market_fees": true, "labor": true, "other": true,
}

func (s *Server) expenseList(w http.ResponseWriter, r *http.Request) {
	year := r.URL.Query().Get("year")
	query := `
		SELECT e.id, e.expense_date, e.category, e.description, e.amount,
			e.apiary_id, a.name, e.hive_id, h.position_label, e.harvest_lot_id,
			hl.lot_code, e.season, e.vendor, e.quantity, e.unit, e.notes
		FROM expenses e
		LEFT JOIN apiaries a ON a.id=e.apiary_id
		LEFT JOIN hives h ON h.id=e.hive_id
		LEFT JOIN harvest_lots hl ON hl.id=e.harvest_lot_id`
	args := []any{}
	if year != "" {
		y, err := strconv.Atoi(year)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid year")
			return
		}
		query += ` WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1`
		args = append(args, y)
	}
	query += ` ORDER BY e.expense_date DESC, e.created_at DESC`
	rows, err := s.pool.Query(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var date time.Time
		var category, description string
		var amount float64
		var apiaryID, hiveID, lotID *uuid.UUID
		var apiaryName, hiveName, lotCode, season, vendor, unit, notes *string
		var quantity *float64
		if err := rows.Scan(&id, &date, &category, &description, &amount,
			&apiaryID, &apiaryName, &hiveID, &hiveName, &lotID, &lotCode,
			&season, &vendor, &quantity, &unit, &notes); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{
			"id": id, "expenseDate": date, "category": category, "description": description,
			"amount": amount, "apiaryId": apiaryID, "apiaryName": apiaryName,
			"hiveId": hiveID, "hiveName": hiveName, "harvestLotId": lotID,
			"lotCode": lotCode, "season": season, "vendor": vendor,
			"quantity": quantity, "unit": unit, "notes": notes,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) expenseCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ExpenseDate  string     `json:"expenseDate"`
		Category     string     `json:"category"`
		Description  string     `json:"description"`
		Amount       float64    `json:"amount"`
		ApiaryID     *uuid.UUID `json:"apiaryId"`
		HiveID       *uuid.UUID `json:"hiveId"`
		HarvestLotID *uuid.UUID `json:"harvestLotId"`
		Season       *string    `json:"season"`
		Vendor       *string    `json:"vendor"`
		Quantity     *float64   `json:"quantity"`
		Unit         *string    `json:"unit"`
		Notes        *string    `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	date, err := parseDate(req.ExpenseDate)
	if err != nil || !expenseCategories[req.Category] ||
		strings.TrimSpace(req.Description) == "" || req.Amount < 0 {
		writeError(w, http.StatusBadRequest, "date, category, description, and non-negative amount are required")
		return
	}
	var id uuid.UUID
	err = s.pool.QueryRow(r.Context(), `
		INSERT INTO expenses
			(expense_date, category, description, amount, apiary_id, hive_id,
			 harvest_lot_id, season, vendor, quantity, unit, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
		date, req.Category, strings.TrimSpace(req.Description), req.Amount,
		req.ApiaryID, req.HiveID, req.HarvestLotID, honeyTrimPtr(req.Season),
		honeyTrimPtr(req.Vendor), req.Quantity, honeyTrimPtr(req.Unit),
		honeyTrimPtr(req.Notes)).Scan(&id)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid apiary, hive, or harvest lot")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) expenseDelete(w http.ResponseWriter, r *http.Request) {
	deleteSimpleRecord(s, w, r, "expenses", "expense")
}

func (s *Server) customerList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT c.id, c.name, c.email, c.phone, c.notes, c.email_opt_in,
			c.referral_code, c.referred_by, c.created_at,
			COUNT(s.id), COALESCE(SUM(s.total_amount), 0), MAX(s.date)
		FROM customers c
		LEFT JOIN honey_sales s ON s.customer_id=c.id AND s.order_status <> 'cancelled'
		GROUP BY c.id ORDER BY c.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var email, phone, notes, referral, referredBy *string
		var optIn bool
		var created time.Time
		var orders int
		var revenue float64
		var lastOrder *time.Time
		if err := rows.Scan(&id, &name, &email, &phone, &notes, &optIn,
			&referral, &referredBy, &created, &orders, &revenue, &lastOrder); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "email": email, "phone": phone, "notes": notes,
			"emailOptIn": optIn, "referralCode": referral, "referredBy": referredBy,
			"createdAt": created, "orderCount": orders, "lifetimeRevenue": revenue,
			"lastOrderDate": lastOrder,
			"reorderReminderDue": optIn && lastOrder != nil &&
				lastOrder.Before(time.Now().AddDate(0, 0, -90)),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

type customerPayload struct {
	Name         string  `json:"name"`
	Email        *string `json:"email"`
	Phone        *string `json:"phone"`
	Notes        *string `json:"notes"`
	EmailOptIn   bool    `json:"emailOptIn"`
	ReferralCode *string `json:"referralCode"`
	ReferredBy   *string `json:"referredBy"`
}

func (s *Server) customerCreate(w http.ResponseWriter, r *http.Request) {
	var req customerPayload
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	referral := honeyTrimPtr(req.ReferralCode)
	if referral == nil {
		v := strings.ToUpper(uuid.NewString()[:8])
		referral = &v
	}
	var id uuid.UUID
	err := s.pool.QueryRow(r.Context(), `
		INSERT INTO customers (name,email,phone,notes,email_opt_in,referral_code,referred_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
		strings.TrimSpace(req.Name), honeyTrimPtr(req.Email), honeyTrimPtr(req.Phone),
		honeyTrimPtr(req.Notes), req.EmailOptIn, referral, honeyTrimPtr(req.ReferredBy)).Scan(&id)
	if err != nil {
		writeError(w, http.StatusConflict, "referral code already exists")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "referralCode": referral})
}

func (s *Server) customerUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req customerPayload
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE customers SET name=$1,email=$2,phone=$3,notes=$4,email_opt_in=$5,
			referral_code=$6,referred_by=$7 WHERE id=$8`,
		strings.TrimSpace(req.Name), honeyTrimPtr(req.Email), honeyTrimPtr(req.Phone),
		honeyTrimPtr(req.Notes), req.EmailOptIn, honeyTrimPtr(req.ReferralCode),
		honeyTrimPtr(req.ReferredBy), id)
	if err != nil {
		writeError(w, http.StatusConflict, "referral code already exists")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "customer not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) priceListList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pool.Query(r.Context(), `
		SELECT p.id, p.name, p.minimum_order_amount, p.is_active,
			COALESCE(jsonb_agg(jsonb_build_object(
				'jarSizeId', i.jar_size_id, 'label', js.label, 'unitPrice', i.unit_price
			) ORDER BY js.sort_order) FILTER (WHERE i.jar_size_id IS NOT NULL), '[]'::jsonb)
		FROM wholesale_price_lists p
		LEFT JOIN wholesale_price_list_items i ON i.price_list_id=p.id
		LEFT JOIN jar_sizes js ON js.id=i.jar_size_id
		GROUP BY p.id ORDER BY p.name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var minimum float64
		var active bool
		var items any
		if err := rows.Scan(&id, &name, &minimum, &active, &items); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		out = append(out, map[string]any{"id": id, "name": name, "minimumOrderAmount": minimum, "isActive": active, "items": items})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) priceListCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name               string  `json:"name"`
		MinimumOrderAmount float64 `json:"minimumOrderAmount"`
		Items              []struct {
			JarSizeID uuid.UUID `json:"jarSizeId"`
			UnitPrice float64   `json:"unitPrice"`
		} `json:"items"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Name) == "" || req.MinimumOrderAmount < 0 {
		writeError(w, http.StatusBadRequest, "name and non-negative minimumOrderAmount are required")
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer tx.Rollback(r.Context())
	var id uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO wholesale_price_lists (name,minimum_order_amount) VALUES ($1,$2) RETURNING id`,
		strings.TrimSpace(req.Name), req.MinimumOrderAmount).Scan(&id); err != nil {
		writeError(w, http.StatusConflict, "price list name already exists")
		return
	}
	for _, item := range req.Items {
		if item.JarSizeID == uuid.Nil || item.UnitPrice < 0 {
			writeError(w, http.StatusBadRequest, "each price-list item needs a jarSizeId and non-negative price")
			return
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO wholesale_price_list_items VALUES ($1,$2,$3)`,
			id, item.JarSizeID, item.UnitPrice); err != nil {
			writeError(w, http.StatusBadRequest, "invalid jarSizeId")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) profitabilityAnalytics(w http.ResponseWriter, r *http.Request) {
	year := requestedYear(r)
	var revenue, expenses, harvested, inventoryValue float64
	var jarsSold int
	err := s.pool.QueryRow(r.Context(), `
		SELECT
			COALESCE((SELECT SUM(total_amount) FROM honey_sales
				WHERE EXTRACT(YEAR FROM date)::integer=$1 AND order_status <> 'cancelled'),0),
			COALESCE((SELECT SUM(amount) FROM expenses
				WHERE EXTRACT(YEAR FROM expense_date)::integer=$1),0),
			COALESCE((SELECT SUM(calculated_honey_weight) FROM honey_harvests
				WHERE EXTRACT(YEAR FROM date)::integer=$1),0),
			COALESCE((SELECT SUM(si.quantity) FROM honey_sale_items si
				JOIN honey_sales s ON s.id=si.sale_id
				WHERE EXTRACT(YEAR FROM s.date)::integer=$1 AND s.order_status <> 'cancelled'),0)`,
		year).Scan(&revenue, &expenses, &harvested, &jarsSold)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	breakEven := make([]map[string]any, 0)
	costPerPound := 0.0
	if harvested > 0 {
		costPerPound = expenses / harvested
	}
	for _, row := range inventory {
		if row.DefaultPrice != nil {
			inventoryValue += float64(row.OnHand) * *row.DefaultPrice
		}
		perJar := 0.0
		if row.HoneyOz != nil {
			perJar = costPerPound * *row.HoneyOz / 16
		}
		breakEven = append(breakEven, map[string]any{
			"jarSizeId": row.JarSizeID, "label": row.Label, "breakEvenPrice": perJar,
			"defaultPrice": row.DefaultPrice, "onHand": row.OnHand,
		})
	}
	channelRows, err := s.pool.Query(r.Context(), `
		SELECT channel, SUM(total_amount), COUNT(*)
		FROM honey_sales WHERE EXTRACT(YEAR FROM date)::integer=$1
			AND order_status <> 'cancelled'
		GROUP BY channel ORDER BY SUM(total_amount) DESC`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	channels := make([]map[string]any, 0)
	for channelRows.Next() {
		var channel string
		var total float64
		var count int
		if err := channelRows.Scan(&channel, &total, &count); err != nil {
			channelRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		channels = append(channels, map[string]any{"channel": channel, "revenue": total, "orderCount": count})
	}
	channelRows.Close()

	jarRows, err := s.pool.Query(r.Context(), `
		WITH lines AS (
			SELECT si.jar_size_id, js.label, js.honey_oz, si.quantity,
				si.quantity * si.unit_price AS gross,
				s.discount_amount,
				SUM(si.quantity * si.unit_price) OVER (PARTITION BY s.id) AS subtotal
			FROM honey_sale_items si
			JOIN honey_sales s ON s.id=si.sale_id
			JOIN jar_sizes js ON js.id=si.jar_size_id
			WHERE EXTRACT(YEAR FROM s.date)::integer=$1
				AND s.order_status <> 'cancelled'
		)
		SELECT jar_size_id, label, honey_oz, SUM(quantity),
			SUM(gross - CASE WHEN subtotal > 0
				THEN discount_amount * gross / subtotal ELSE 0 END)
		FROM lines GROUP BY jar_size_id, label, honey_oz
		ORDER BY 5 DESC`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byJarSize := make([]map[string]any, 0)
	for jarRows.Next() {
		var id uuid.UUID
		var label string
		var honeyOz *float64
		var quantity int
		var jarRevenue float64
		if err := jarRows.Scan(&id, &label, &honeyOz, &quantity, &jarRevenue); err != nil {
			jarRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		estimatedCost := 0.0
		if honeyOz != nil {
			estimatedCost = float64(quantity) * *honeyOz / 16 * costPerPound
		}
		byJarSize = append(byJarSize, map[string]any{
			"jarSizeId": id, "label": label, "jarsSold": quantity,
			"revenue": jarRevenue, "estimatedHoneyCost": estimatedCost,
			"estimatedMargin": jarRevenue - estimatedCost,
		})
	}
	jarRows.Close()

	lotRows, err := s.pool.Query(r.Context(), `
		WITH lot_revenue AS (
			SELECT harvest_lot_id, SUM(total_amount) revenue
			FROM honey_sales
			WHERE EXTRACT(YEAR FROM date)::integer=$1
				AND order_status <> 'cancelled' AND harvest_lot_id IS NOT NULL
			GROUP BY harvest_lot_id
		), lot_cost AS (
			SELECT harvest_lot_id, SUM(amount) expenses
			FROM expenses
			WHERE EXTRACT(YEAR FROM expense_date)::integer=$1
				AND harvest_lot_id IS NOT NULL
			GROUP BY harvest_lot_id
		)
		SELECT lot.id, lot.lot_code, lot.season, lot.honey_weight_lbs,
			COALESCE(r.revenue,0), COALESCE(c.expenses,0)
		FROM harvest_lots lot
		LEFT JOIN lot_revenue r ON r.harvest_lot_id=lot.id
		LEFT JOIN lot_cost c ON c.harvest_lot_id=lot.id
		WHERE EXTRACT(YEAR FROM lot.extraction_date)::integer=$1
			OR r.revenue IS NOT NULL OR c.expenses IS NOT NULL
		ORDER BY lot.extraction_date DESC, lot.lot_code`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	byLot := make([]map[string]any, 0)
	for lotRows.Next() {
		var id uuid.UUID
		var code string
		var season *string
		var pounds, lotRevenue, lotExpenses float64
		if err := lotRows.Scan(&id, &code, &season, &pounds, &lotRevenue, &lotExpenses); err != nil {
			lotRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		byLot = append(byLot, map[string]any{
			"harvestLotId": id, "lotCode": code, "season": season,
			"harvestedPounds": pounds, "revenue": lotRevenue,
			"expenses": lotExpenses, "margin": lotRevenue - lotExpenses,
		})
	}
	lotRows.Close()

	seasonRows, err := s.pool.Query(r.Context(), `
		WITH revenue AS (
			SELECT COALESCE(lot.season,'Unassigned') season, SUM(s.total_amount) revenue
			FROM honey_sales s
			LEFT JOIN harvest_lots lot ON lot.id=s.harvest_lot_id
			WHERE EXTRACT(YEAR FROM s.date)::integer=$1 AND s.order_status <> 'cancelled'
			GROUP BY 1
		), costs AS (
			SELECT COALESCE(lot.season,e.season,'Unassigned') season, SUM(e.amount) expenses
			FROM expenses e
			LEFT JOIN harvest_lots lot ON lot.id=e.harvest_lot_id
			WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1
			GROUP BY 1
		), harvest_weight AS (
			SELECT COALESCE(season,'Unassigned') season, SUM(honey_weight_lbs) pounds
			FROM harvest_lots
			WHERE EXTRACT(YEAR FROM extraction_date)::integer=$1
			GROUP BY 1
		), keys AS (
			SELECT season FROM revenue UNION SELECT season FROM costs UNION SELECT season FROM harvest_weight
		)
		SELECT keys.season, COALESCE(h.pounds,0), COALESCE(r.revenue,0), COALESCE(c.expenses,0)
		FROM keys
		LEFT JOIN revenue r USING (season)
		LEFT JOIN costs c USING (season)
		LEFT JOIN harvest_weight h USING (season)
		ORDER BY keys.season`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	bySeason := make([]map[string]any, 0)
	for seasonRows.Next() {
		var season string
		var pounds, seasonRevenue, seasonExpenses float64
		if err := seasonRows.Scan(&season, &pounds, &seasonRevenue, &seasonExpenses); err != nil {
			seasonRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		bySeason = append(bySeason, map[string]any{
			"season": season, "harvestedPounds": pounds,
			"revenue": seasonRevenue, "expenses": seasonExpenses,
			"margin": seasonRevenue - seasonExpenses,
		})
	}
	seasonRows.Close()

	margin := revenue - expenses
	writeJSON(w, http.StatusOK, map[string]any{
		"year": year, "revenue": revenue, "expenses": expenses, "grossMargin": margin,
		"marginPercent": safePercent(margin, revenue), "harvestedPounds": harvested,
		"costPerHarvestedPound": costPerPound, "costPerJarSold": safeDivide(expenses, float64(jarsSold)),
		"inventoryValue": inventoryValue, "jarsSold": jarsSold,
		"breakEvenByJarSize": breakEven, "byChannel": channels,
		"byJarSize": byJarSize, "byHarvestLot": byLot, "bySeason": bySeason,
	})
}

func (s *Server) economicsAnalytics(w http.ResponseWriter, r *http.Request) {
	year := requestedYear(r)
	rows, err := s.pool.Query(r.Context(), `
		WITH yields AS (
			SELECT a.id AS apiary_id, a.name,
				COALESCE(SUM(hh.calculated_honey_weight),0) AS pounds,
				COUNT(DISTINCT h.id) FILTER (WHERE hh.id IS NOT NULL) AS producing_hives
			FROM apiaries a
			LEFT JOIN hives h ON h.apiary_id=a.id
			LEFT JOIN honey_harvests hh ON hh.hive_id=h.id
				AND EXTRACT(YEAR FROM hh.date)::integer=$1
			GROUP BY a.id
		), costs AS (
			SELECT COALESCE(e.apiary_id, h.apiary_id) apiary_id,
				SUM(e.amount) expenses,
				SUM(e.amount) FILTER (WHERE e.category='feed') feed_cost,
				SUM(e.amount) FILTER (WHERE e.category='treatments') treatment_cost
			FROM expenses e LEFT JOIN hives h ON h.id=e.hive_id
			WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1
			GROUP BY COALESCE(e.apiary_id, h.apiary_id)
		), general_costs AS (
			SELECT COALESCE(SUM(e.amount),0) expenses,
				COALESCE(SUM(e.amount) FILTER (WHERE e.category='feed'),0) feed_cost,
				COALESCE(SUM(e.amount) FILTER (WHERE e.category='treatments'),0) treatment_cost
			FROM expenses e
			LEFT JOIN hives h ON h.id=e.hive_id
			WHERE EXTRACT(YEAR FROM e.expense_date)::integer=$1
				AND COALESCE(e.apiary_id,h.apiary_id) IS NULL
		), totals AS (
			SELECT COALESCE(SUM(total_amount),0) revenue
			FROM honey_sales WHERE EXTRACT(YEAR FROM date)::integer=$1
				AND order_status <> 'cancelled'
		), yield_total AS (
			SELECT COALESCE(SUM(pounds),0) pounds FROM yields
		)
		SELECT y.apiary_id, y.name, y.pounds, y.producing_hives,
			COALESCE(c.expenses,0) + CASE WHEN yt.pounds > 0
				THEN gc.expenses * y.pounds / yt.pounds ELSE 0 END,
			COALESCE(c.feed_cost,0) + CASE WHEN yt.pounds > 0
				THEN gc.feed_cost * y.pounds / yt.pounds ELSE 0 END,
			COALESCE(c.treatment_cost,0) + CASE WHEN yt.pounds > 0
				THEN gc.treatment_cost * y.pounds / yt.pounds ELSE 0 END,
			CASE WHEN yt.pounds > 0 THEN t.revenue * y.pounds / yt.pounds ELSE 0 END
		FROM yields y
		LEFT JOIN costs c ON c.apiary_id=y.apiary_id
		CROSS JOIN totals t CROSS JOIN yield_total yt CROSS JOIN general_costs gc
		ORDER BY y.pounds DESC`, year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	byID := make(map[uuid.UUID]map[string]any)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var pounds, expenses, feedCost, treatmentCost, revenue float64
		var producing int
		if err := rows.Scan(&id, &name, &pounds, &producing, &expenses,
			&feedCost, &treatmentCost, &revenue); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		item := map[string]any{
			"apiaryId": id, "apiaryName": name, "harvestedPounds": pounds,
			"producingHives": producing, "revenueAllocated": revenue,
			"expenses": expenses, "margin": revenue - expenses,
			"poundsPerHive":          safeDivide(pounds, float64(producing)),
			"feedCostPerColony":      safeDivide(feedCost, float64(producing)),
			"treatmentCostPerColony": safeDivide(treatmentCost, float64(producing)),
		}
		out = append(out, item)
		byID[id] = item
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}

	winterStart := time.Date(year, time.October, 1, 0, 0, 0, 0, time.UTC)
	survivalDate := time.Date(year+1, time.April, 1, 0, 0, 0, 0, time.UTC)
	yearStart := time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC)
	yearEnd := yearStart.AddDate(1, 0, 0)
	outcomeRows, err := s.pool.Query(r.Context(), `
		SELECT a.id,
			COUNT(DISTINCT h.id) FILTER (
				WHERE (h.installed_date IS NULL OR h.installed_date <= $1)
					AND (h.deadout_date IS NULL OR h.deadout_date >= $1)
			),
			COUNT(DISTINCT h.id) FILTER (
				WHERE (h.installed_date IS NULL OR h.installed_date <= $1)
					AND (h.deadout_date IS NULL OR h.deadout_date >= $2)
			),
			COUNT(DISTINCT sp.id) FILTER (
				WHERE sp.split_date >= $3 AND sp.split_date < $4
			),
			COUNT(DISTINCT sp.child_hive_id) FILTER (
				WHERE sp.split_date >= $3 AND sp.split_date < $4
					AND (child.deadout_date IS NULL OR child.deadout_date >= $2)
			),
			COUNT(DISTINCT q.id) FILTER (
				WHERE q.introduced_date >= $3 AND q.introduced_date < $4
			),
			COUNT(DISTINCT q.id) FILTER (
				WHERE q.introduced_date >= $3 AND q.introduced_date < $4
					AND q.status='active'
			)
		FROM apiaries a
		LEFT JOIN hives h ON h.apiary_id=a.id
		LEFT JOIN hive_splits sp ON sp.parent_hive_id=h.id
		LEFT JOIN hives child ON child.id=sp.child_hive_id
		LEFT JOIN queens q ON q.hive_id=h.id
		GROUP BY a.id`,
		winterStart, survivalDate, yearStart, yearEnd)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for outcomeRows.Next() {
		var id uuid.UUID
		var entered, survived, splits, survivingSplits, queens, activeQueens int
		if err := outcomeRows.Scan(
			&id, &entered, &survived, &splits, &survivingSplits, &queens, &activeQueens,
		); err != nil {
			outcomeRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		if item := byID[id]; item != nil {
			item["enteredWinter"] = entered
			item["survivedWinter"] = survived
			item["winterSurvivalRate"] = safePercent(float64(survived), float64(entered))
			item["splitsCreated"] = splits
			item["splitChildrenSurviving"] = survivingSplits
			item["queensIntroduced"] = queens
			item["introducedQueensActive"] = activeQueens
		}
	}
	outcomeRows.Close()
	writeJSON(w, http.StatusOK, map[string]any{"year": year, "apiaries": out})
}

func safeDivide(value, divisor float64) float64 {
	if divisor == 0 {
		return 0
	}
	return value / divisor
}

func safePercent(value, divisor float64) float64 {
	return safeDivide(value, divisor) * 100
}

func (s *Server) productionPlan(w http.ResponseWriter, r *http.Request) {
	lookbackDays := 90
	if raw := r.URL.Query().Get("days"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 7 && v <= 730 {
			lookbackDays = v
		}
	}
	horizonDays := 30
	if raw := r.URL.Query().Get("horizon"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 1 && v <= 180 {
			horizonDays = v
		}
	}
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	salesRows, err := s.pool.Query(r.Context(), `
		SELECT si.jar_size_id, COALESCE(SUM(si.quantity),0)
		FROM honey_sale_items si JOIN honey_sales s ON s.id=si.sale_id
		WHERE s.date >= CURRENT_DATE - $1::integer AND s.order_status <> 'cancelled'
		GROUP BY si.jar_size_id`, lookbackDays)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	sold := map[uuid.UUID]int{}
	for salesRows.Next() {
		var id uuid.UUID
		var quantity int
		if err := salesRows.Scan(&id, &quantity); err != nil {
			salesRows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		sold[id] = quantity
	}
	salesRows.Close()
	recommendations := make([]map[string]any, 0)
	totalPounds, projectedRevenue := 0.0, 0.0
	for _, row := range inventory {
		projectedDemand := int(math.Ceil(float64(sold[row.JarSizeID]) / float64(lookbackDays) * float64(horizonDays)))
		needed := projectedDemand - row.OnHand
		if needed < 0 {
			needed = 0
		}
		pounds := 0.0
		if row.HoneyOz != nil {
			pounds = float64(needed) * *row.HoneyOz / 16
		}
		revenue := 0.0
		if row.DefaultPrice != nil {
			revenue = float64(needed) * *row.DefaultPrice
		}
		totalPounds += pounds
		projectedRevenue += revenue
		recommendations = append(recommendations, map[string]any{
			"jarSizeId": row.JarSizeID, "label": row.Label, "onHand": row.OnHand,
			"soldInLookback": sold[row.JarSizeID], "projectedDemand": projectedDemand,
			"recommendedToBottle": needed, "packagingRequired": needed,
			"honeyRequiredLbs": pounds, "projectedRevenue": revenue,
		})
	}
	sort.Slice(recommendations, func(i, j int) bool {
		return recommendations[i]["recommendedToBottle"].(int) > recommendations[j]["recommendedToBottle"].(int)
	})
	var wholesaleReserved, bulkOnHand float64
	_ = s.pool.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(si.quantity * COALESCE(js.honey_oz,0) / 16.0),0)
		FROM honey_sale_items si
		JOIN honey_sales s ON s.id=si.sale_id
		JOIN jar_sizes js ON js.id=si.jar_size_id
		WHERE s.channel='wholesale' AND s.order_status IN ('draft','pending')`).Scan(&wholesaleReserved)
	overview, err := s.honeyOverviewValues(r.Context())
	if err == nil {
		bulkOnHand = overview["bulkOnHandLbs"].(float64)
	}
	var optedIn int
	_ = s.pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM customers WHERE email_opt_in`).Scan(&optedIn)
	writeJSON(w, http.StatusOK, map[string]any{
		"lookbackDays": lookbackDays, "horizonDays": horizonDays,
		"recommendations": recommendations, "honeyRequiredLbs": totalPounds,
		"projectedRevenue": projectedRevenue, "bulkOnHandLbs": bulkOnHand,
		"bulkReservedForWholesaleLbs": wholesaleReserved,
		"bulkAvailableAfterPlanLbs":   bulkOnHand - wholesaleReserved - totalPounds,
		"releaseAlertSubscribers":     optedIn,
	})
}

func (s *Server) honeyOverviewValues(ctx context.Context) (map[string]any, error) {
	// Keep the production-plan calculation aligned with /honey/overview without
	// routing an internal HTTP request.
	var totalHarvested, jarredLbs, bulkUsed, loss float64
	err := s.pool.QueryRow(ctx, `
		SELECT
			COALESCE((
				SELECT SUM(COALESCE(hs.total_extracted_weight, (
					SELECT SUM(hh.calculated_honey_weight) FROM honey_harvests hh WHERE hh.session_id=hs.id
				))) FROM harvest_sessions hs
			),0) + COALESCE((SELECT SUM(calculated_honey_weight) FROM honey_harvests WHERE session_id IS NULL),0),
			COALESCE((SELECT SUM(hm.quantity * COALESCE(js.honey_oz,0) / 16.0)
				FROM honey_movements hm JOIN jar_sizes js ON js.id=hm.jar_size_id
				WHERE hm.kind='jarring'),0),
			COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE kind='bulk_use'),0),
			COALESCE((SELECT SUM(amount_lbs) FROM honey_movements WHERE kind='loss'),0)`).
		Scan(&totalHarvested, &jarredLbs, &bulkUsed, &loss)
	if err != nil {
		return nil, err
	}
	return map[string]any{"bulkOnHandLbs": totalHarvested - jarredLbs - bulkUsed - loss}, nil
}

func (s *Server) lowStockAlerts(w http.ResponseWriter, r *http.Request) {
	inventory, err := s.honeyJarInventory(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT id, low_stock_threshold FROM jar_sizes`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	thresholds := map[uuid.UUID]int{}
	for rows.Next() {
		var id uuid.UUID
		var threshold int
		if err := rows.Scan(&id, &threshold); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		thresholds[id] = threshold
	}
	rows.Close()
	out := make([]map[string]any, 0)
	for _, row := range inventory {
		if row.OnHand <= thresholds[row.JarSizeID] {
			out = append(out, map[string]any{
				"jarSizeId": row.JarSizeID, "label": row.Label,
				"onHand": row.OnHand, "threshold": thresholds[row.JarSizeID],
			})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) marketDayReconciliation(w http.ResponseWriter, r *http.Request) {
	date := r.URL.Query().Get("date")
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	parsed, err := parseDate(date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid date")
		return
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT payment_method, channel, COUNT(*), SUM(total_amount), SUM(amount_paid),
			SUM(total_amount-amount_paid)
		FROM honey_sales
		WHERE date::date=$1::date AND order_status <> 'cancelled'
		GROUP BY payment_method, channel ORDER BY payment_method, channel`, parsed)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()
	lines := make([]map[string]any, 0)
	totalSales, totalPaid, totalDue := 0.0, 0.0, 0.0
	orders := 0
	for rows.Next() {
		var payment, channel string
		var count int
		var sales, paid, due float64
		if err := rows.Scan(&payment, &channel, &count, &sales, &paid, &due); err != nil {
			writeError(w, http.StatusInternalServerError, "database error")
			return
		}
		orders += count
		totalSales += sales
		totalPaid += paid
		totalDue += due
		lines = append(lines, map[string]any{
			"paymentMethod": payment, "channel": channel, "orderCount": count,
			"sales": sales, "paid": paid, "balanceDue": due,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"date": parsed, "orderCount": orders, "grossSales": totalSales,
		"amountCollected": totalPaid, "balanceDue": totalDue, "breakdown": lines,
	})
}

func (s *Server) saleReceipt(w http.ResponseWriter, r *http.Request) {
	id, err := uuidParam(r, "id")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sales, err := s.honeyListSales(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		return
	}
	for _, sale := range sales {
		if sale.ID == id {
			writeJSON(w, http.StatusOK, map[string]any{
				"seller": "Beez Trackz Apiary", "sale": sale,
				"balanceDue":   math.Max(0, sale.TotalAmount-sale.AmountPaid),
				"documentType": map[bool]string{true: "receipt", false: "invoice"}[sale.AmountPaid >= sale.TotalAmount],
			})
			return
		}
	}
	writeError(w, http.StatusNotFound, "sale not found")
}
