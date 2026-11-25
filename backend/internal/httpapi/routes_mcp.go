package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const mcpProtocolVersion = "2025-11-25"

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpError       `json:"error,omitempty"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpToolResult struct {
	Content           []map[string]any `json:"content"`
	StructuredContent any              `json:"structuredContent,omitempty"`
	IsError           bool             `json:"isError,omitempty"`
}

func (s *Server) mountMCP(r chi.Router) {
	r.Get("/mcp", s.mcpGet)
	r.Post("/mcp", s.mcpPost)
}

func (s *Server) mcpGet(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Allow", http.MethodPost)
	writeError(w, http.StatusMethodNotAllowed,
		"this MCP endpoint uses immediate JSON responses over Streamable HTTP")
}

// validMCPOrigin guards the MCP endpoint against DNS-rebinding browsers. It
// shares originAllowed with the REST CSRF middleware (middleware.go) so both
// seams agree on what "first-party" means; an absent Origin stays allowed
// here because MCP clients are not browsers.
func (s *Server) validMCPOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	return s.originAllowed(origin)
}

func (s *Server) mcpPost(w http.ResponseWriter, r *http.Request) {
	if !s.validMCPOrigin(r) {
		writeError(w, http.StatusForbidden, "untrusted MCP origin")
		return
	}
	if version := r.Header.Get("MCP-Protocol-Version"); version != "" &&
		version != mcpProtocolVersion && version != "2025-06-18" {
		writeError(w, http.StatusBadRequest, "unsupported MCP protocol version")
		return
	}
	var request mcpRequest
	if err := decodeJSON(r, &request); err != nil || request.JSONRPC != "2.0" {
		s.writeMCPError(w, nil, -32600, "invalid JSON-RPC request")
		return
	}
	if strings.HasPrefix(request.Method, "notifications/") {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	switch request.Method {
	case "initialize":
		writeJSON(w, http.StatusOK, mcpResponse{
			JSONRPC: "2.0",
			ID:      request.ID,
			Result: map[string]any{
				"protocolVersion": mcpProtocolVersion,
				"capabilities": map[string]any{
					"tools": map[string]any{"listChanged": false},
				},
				"serverInfo": map[string]any{
					"name":    "beez-trackz",
					"title":   s.resolvedBrand().DisplayName,
					"version": "1.0.0",
				},
			},
		})
	case "ping":
		writeJSON(w, http.StatusOK, mcpResponse{
			JSONRPC: "2.0", ID: request.ID, Result: map[string]any{},
		})
	case "tools/list":
		writeJSON(w, http.StatusOK, mcpResponse{
			JSONRPC: "2.0", ID: request.ID,
			Result: map[string]any{"tools": mcpTools()},
		})
	case "tools/call":
		result, err := s.mcpCallTool(r, request.Params)
		if err != nil {
			result = mcpToolError(err.Error())
		}
		writeJSON(w, http.StatusOK, mcpResponse{
			JSONRPC: "2.0", ID: request.ID, Result: result,
		})
	default:
		s.writeMCPError(w, request.ID, -32601, "method not found")
	}
}

func (s *Server) writeMCPError(
	w http.ResponseWriter,
	id json.RawMessage,
	code int,
	message string,
) {
	writeJSON(w, http.StatusOK, mcpResponse{
		JSONRPC: "2.0", ID: id, Error: &mcpError{Code: code, Message: message},
	})
}

func mcpToolSuccess(value any) mcpToolResult {
	raw, _ := json.Marshal(value)
	return mcpToolResult{
		Content:           []map[string]any{{"type": "text", "text": string(raw)}},
		StructuredContent: value,
	}
}

func mcpToolError(message string) mcpToolResult {
	return mcpToolResult{
		Content: []map[string]any{{"type": "text", "text": message}},
		IsError: true,
	}
}

// --- argument helpers ---------------------------------------------------

func mcpUUID(arguments map[string]json.RawMessage, name string, required bool) (*uuid.UUID, error) {
	raw, ok := arguments[name]
	if !ok || string(raw) == "null" {
		if required {
			return nil, fmt.Errorf("%s is required", name)
		}
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a UUID", name)
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be a UUID", name)
	}
	return &id, nil
}

// mcpString reads an optional string argument; nil when absent or null.
func mcpString(arguments map[string]json.RawMessage, name string) (*string, error) {
	raw, ok := arguments[name]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a string", name)
	}
	return &value, nil
}

// mcpRequiredString reads a string argument that must be present and
// non-blank.
func mcpRequiredString(arguments map[string]json.RawMessage, name string) (string, error) {
	value, err := mcpString(arguments, name)
	if err != nil {
		return "", err
	}
	if value == nil || strings.TrimSpace(*value) == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return *value, nil
}

// mcpPopBool removes a boolean argument (such as allowDuplicate) so the
// remaining arguments can be forwarded to a REST handler that rejects
// unknown fields.
func mcpPopBool(arguments map[string]json.RawMessage, name string) (bool, error) {
	raw, ok := arguments[name]
	if !ok {
		return false, nil
	}
	delete(arguments, name)
	if string(raw) == "null" {
		return false, nil
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("%s must be a boolean", name)
	}
	return value, nil
}

// mcpStringList reads an optional array of strings.
func mcpStringList(arguments map[string]json.RawMessage, name string) ([]string, error) {
	raw, ok := arguments[name]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s must be an array of strings", name)
	}
	return values, nil
}

// mcpDay parses a request date the way the REST handlers do (parseDate) and
// returns both the stored instant and the calendar day it belongs to.
func mcpDay(raw, name string) (time.Time, time.Time, error) {
	at, err := parseDate(raw)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("%s must be a date (YYYY-MM-DD)", name)
	}
	return at, eventDay(at), nil
}

// mcpRangeQuery turns from/to/types arguments into the query string the
// activity and timeline handlers take.
func mcpRangeQuery(arguments map[string]json.RawMessage) (url.Values, error) {
	query := url.Values{}
	for _, name := range []string{"from", "to"} {
		value, err := mcpString(arguments, name)
		if err != nil {
			return nil, err
		}
		if value != nil && strings.TrimSpace(*value) != "" {
			if _, err := parseCivilDate(*value); err != nil {
				return nil, fmt.Errorf("%s must be a date (YYYY-MM-DD)", name)
			}
			query.Set(name, strings.TrimSpace(*value))
		}
	}
	types, err := mcpStringList(arguments, "types")
	if err != nil {
		return nil, err
	}
	if len(types) > 0 {
		if _, err := parseActivityTypes(strings.Join(types, ",")); err != nil {
			return nil, err
		}
		query.Set("types", strings.Join(types, ","))
	}
	return query, nil
}

// mcpValidateArguments enforces the tool's input schema at the top level:
// every argument must be a declared property (additionalProperties: false)
// and every required property must be present. Nested objects are checked by
// the strict decoders behind each tool.
func mcpValidateArguments(name string, arguments map[string]json.RawMessage) error {
	tool, ok := mcpToolIndex()[name]
	if !ok {
		return fmt.Errorf("unknown tool %q", name)
	}
	schema, _ := tool["inputSchema"].(map[string]any)
	properties, _ := schema["properties"].(map[string]any)
	unknown := make([]string, 0)
	for key := range arguments {
		if _, ok := properties[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return fmt.Errorf("unknown argument(s) for %s: %s", name, strings.Join(unknown, ", "))
	}
	required, _ := schema["required"].([]string)
	for _, key := range required {
		raw, ok := arguments[key]
		if !ok || string(raw) == "null" {
			return fmt.Errorf("%s is required", key)
		}
	}
	return nil
}

// --- authorization helpers ----------------------------------------------
//
// The REST permission helpers write their refusal to a ResponseWriter; MCP
// turns that refusal into the tool error.

func mcpRecorderError(recorder *httptest.ResponseRecorder) error {
	var value struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &value)
	if value.Error == "" {
		value.Error = fmt.Sprintf("request failed (%d)", recorder.Code)
	}
	return errors.New(value.Error)
}

func (s *Server) mcpRequireHive(r *http.Request, hiveID uuid.UUID, edit bool) error {
	recorder := httptest.NewRecorder()
	if !s.requireHiveRole(recorder, r, hiveID, edit) {
		return mcpRecorderError(recorder)
	}
	return nil
}

func (s *Server) mcpRequireApiary(r *http.Request, apiaryID uuid.UUID, edit bool) error {
	recorder := httptest.NewRecorder()
	if !s.requireApiaryRole(recorder, r, apiaryID, edit) {
		return mcpRecorderError(recorder)
	}
	return nil
}

// mcpRequireOwner mirrors requireOwnerRole, naming the missing record.
func (s *Server) mcpRequireOwner(r *http.Request, ownerType string, id uuid.UUID, edit bool) error {
	recorder := httptest.NewRecorder()
	if !s.requireOwnerRole(recorder, r, ownerType, id, edit) {
		if recorder.Code == http.StatusNotFound {
			return fmt.Errorf("%s not found", ownerType)
		}
		return mcpRecorderError(recorder)
	}
	return nil
}

// --- dispatch -------------------------------------------------------------

func (s *Server) mcpCallTool(r *http.Request, raw json.RawMessage) (mcpToolResult, error) {
	var call struct {
		Name      string                     `json:"name"`
		Arguments map[string]json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &call); err != nil || call.Name == "" {
		return mcpToolResult{}, errors.New("tool name is required")
	}
	if call.Arguments == nil {
		call.Arguments = map[string]json.RawMessage{}
	}
	if err := mcpValidateArguments(call.Name, call.Arguments); err != nil {
		return mcpToolResult{}, err
	}
	args := call.Arguments

	switch call.Name {
	// reads
	case "list_apiaries":
		return s.mcpListApiaries(r)
	case "list_hives":
		return s.mcpListHives(r, args)
	case "get_hive":
		hiveID, err := mcpUUID(args, "hiveId", true)
		if err != nil {
			return mcpToolResult{}, err
		}
		if !s.requireHiveRole(httptest.NewRecorder(), r, *hiveID, false) {
			return mcpToolResult{}, errors.New("hive access denied")
		}
		item, err := s.hiveFetch(r.Context(), *hiveID)
		if err != nil {
			return mcpToolResult{}, errors.New("hive not found")
		}
		return mcpToolSuccess(item), nil
	case "get_hive_timeline":
		query, err := mcpRangeQuery(args)
		if err != nil {
			return mcpToolResult{}, err
		}
		return s.mcpCallIDHandlerQuery(r, args, "hiveId", false, s.hiveTimeline, query)
	case "get_apiary_activity":
		query, err := mcpRangeQuery(args)
		if err != nil {
			return mcpToolResult{}, err
		}
		return s.mcpCallIDHandlerQuery(r, args, "apiaryId", false, s.handleApiaryActivity, query)
	case "list_apiary_observations":
		return s.mcpListApiaryObservations(r, args)
	case "get_apiary_weather":
		apiaryID, err := mcpUUID(args, "apiaryId", true)
		if err != nil {
			return mcpToolResult{}, err
		}
		if !s.requireApiaryRole(httptest.NewRecorder(), r, *apiaryID, false) {
			return mcpToolResult{}, errors.New("apiary access denied")
		}
		value, err := s.loadApiaryWeather(r, *apiaryID)
		if err != nil {
			return mcpToolResult{}, fmt.Errorf("weather unavailable: %w", err)
		}
		return mcpToolSuccess(value), nil
	case "get_bloom_predictions":
		return s.mcpCallIDHandler(r, args, "apiaryId", false, s.apiaryBloomPredictions)
	case "get_queen_performance":
		return s.mcpCallQueenPerformance(r, args)
	case "get_varroa_summary":
		return s.mcpVarroaSummary(r, args)
	case "get_treatment_locks":
		return s.mcpTreatmentLocks(r, args)

	// writes
	case "record_inspection":
		return s.mcpRecordInspection(r, args)
	case "update_inspection":
		return s.mcpUpdateInspection(r, args)
	case "delete_inspection":
		return s.mcpDeleteInspection(r, args)
	case "record_feeding":
		return s.mcpRecordFeeding(r, args)
	case "record_mite_count":
		return s.mcpRecordMiteCount(r, args)
	case "record_treatment":
		return s.mcpRecordTreatment(r, args)
	case "record_queen_event":
		return s.mcpRecordQueenEvent(r, args)
	case "record_apiary_observation":
		return s.mcpRecordApiaryObservation(r, args)
	case "record_bloom_observation":
		return s.mcpRecordBloomObservation(r, args)
	case "set_hive_status":
		return s.mcpSetHiveStatus(r, args)
	case "record_visit":
		return s.mcpRecordVisit(r, args)
	default:
		return mcpToolResult{}, fmt.Errorf("unknown tool %q", call.Name)
	}
}

func (s *Server) mcpListApiaries(r *http.Request) (mcpToolResult, error) {
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT apiary.id,apiary.name,apiary.latitude,apiary.longitude,
			apiary.elevation_m,apiary.elevation_source,count(hive.id)::integer
		FROM apiaries apiary
		LEFT JOIN hives hive ON hive.apiary_id=apiary.id AND NOT hive.is_archived
		WHERE ($1::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$2 AND membership.apiary_id=apiary.id
		))
		GROUP BY apiary.id ORDER BY apiary.name`, user.IsAdmin, user.ID)
	if err != nil {
		return mcpToolResult{}, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var name string
		var latitude, longitude, elevationM *float64
		var elevationSource *string
		var hives int
		if err := rows.Scan(&id, &name, &latitude, &longitude,
			&elevationM, &elevationSource, &hives); err != nil {
			return mcpToolResult{}, err
		}
		items = append(items, map[string]any{
			"id": id, "name": name, "latitude": latitude,
			"longitude": longitude, "elevationM": elevationM,
			"elevationSource": elevationSource, "hiveCount": hives,
		})
	}
	return mcpToolSuccess(items), rows.Err()
}

var mcpHiveStatusFilters = []string{"active", "dead", "sold", "combined", "all"}

// mcpParseHiveStatusFilter defaults to "active", meaning status active and
// not archived: the colonies that are actually in the yard today.
func mcpParseHiveStatusFilter(raw *string) (string, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return "active", nil
	}
	value := strings.ToLower(strings.TrimSpace(*raw))
	for _, allowed := range mcpHiveStatusFilters {
		if value == allowed {
			return value, nil
		}
	}
	return "", fmt.Errorf("status must be one of %s", strings.Join(mcpHiveStatusFilters, ", "))
}

func (s *Server) mcpListHives(
	r *http.Request,
	arguments map[string]json.RawMessage,
) (mcpToolResult, error) {
	apiaryID, err := mcpUUID(arguments, "apiaryId", false)
	if err != nil {
		return mcpToolResult{}, err
	}
	rawStatus, err := mcpString(arguments, "status")
	if err != nil {
		return mcpToolResult{}, err
	}
	status, err := mcpParseHiveStatusFilter(rawStatus)
	if err != nil {
		return mcpToolResult{}, err
	}
	label, err := mcpString(arguments, "positionLabel")
	if err != nil {
		return mcpToolResult{}, err
	}
	if label != nil && strings.TrimSpace(*label) == "" {
		label = nil
	}
	if apiaryID != nil &&
		!s.requireApiaryRole(httptest.NewRecorder(), r, *apiaryID, false) {
		return mcpToolResult{}, errors.New("apiary access denied")
	}
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), hiveSelectSQL+`
		WHERE ($1::uuid IS NULL OR h.apiary_id=$1)
		  AND ($2::boolean OR EXISTS (
			SELECT 1 FROM apiary_memberships membership
			WHERE membership.user_id=$3 AND membership.apiary_id=h.apiary_id
		  ))
		  AND ($4::text = 'all'
			OR ($4::text = 'active' AND h.status = 'active' AND NOT h.is_archived)
			OR ($4::text NOT IN ('all', 'active') AND h.status::text = $4::text))
		  AND ($5::text IS NULL OR lower(btrim(h.position_label)) = lower(btrim($5::text)))
		ORDER BY a.name, h.position_label, h.installed_date DESC NULLS LAST`,
		apiaryID, user.IsAdmin, user.ID, status, label)
	if err != nil {
		return mcpToolResult{}, err
	}
	items, err := hiveCollectRows(rows)
	if err != nil {
		return mcpToolResult{}, err
	}
	return mcpToolSuccess(items), nil
}

func hiveCollectRows(rows interface {
	Next() bool
	Scan(...any) error
	Close()
	Err() error
}) ([]hiveJSON, error) {
	defer rows.Close()
	items := []hiveJSON{}
	for rows.Next() {
		item, err := hiveScanRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

// --- REST handler reuse ---------------------------------------------------
//
// MCP tools reuse the REST handlers through httptest so validation,
// permissions, and response shapes stay identical.

// mcpInvoke runs a REST handler with an optional {id} route parameter, query
// string, and JSON body.
func mcpInvoke(
	r *http.Request,
	handler http.HandlerFunc,
	id *uuid.UUID,
	query url.Values,
	body any,
) (*httptest.ResponseRecorder, error) {
	ctx := r.Context()
	if id != nil {
		routeContext := chi.NewRouteContext()
		routeContext.URLParams.Add("id", id.String())
		ctx = context.WithValue(ctx, chi.RouteCtxKey, routeContext)
	}
	cloned := r.Clone(ctx)
	cloned.URL = &url.URL{Path: r.URL.Path}
	if query != nil {
		cloned.URL.RawQuery = query.Encode()
	}
	cloned.Body = http.NoBody
	cloned.ContentLength = 0
	cloned.Header = r.Header.Clone()
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		cloned.Body = ioNopCloser{Reader: bytes.NewReader(encoded)}
		cloned.ContentLength = int64(len(encoded))
		cloned.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler(recorder, cloned)
	return recorder, nil
}

func mcpRecorderResult(recorder *httptest.ResponseRecorder) (mcpToolResult, error) {
	if recorder.Code < 200 || recorder.Code >= 300 {
		return mcpToolResult{}, mcpRecorderError(recorder)
	}
	var value any
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		return mcpToolResult{}, err
	}
	return mcpToolSuccess(value), nil
}

func (s *Server) mcpCallIDHandler(
	r *http.Request,
	arguments map[string]json.RawMessage,
	name string,
	edit bool,
	handler http.HandlerFunc,
) (mcpToolResult, error) {
	return s.mcpCallIDHandlerQuery(r, arguments, name, edit, handler, nil)
}

func (s *Server) mcpCallIDHandlerQuery(
	r *http.Request,
	arguments map[string]json.RawMessage,
	name string,
	edit bool,
	handler http.HandlerFunc,
	query url.Values,
) (mcpToolResult, error) {
	id, err := mcpUUID(arguments, name, true)
	if err != nil {
		return mcpToolResult{}, err
	}
	var allowed bool
	if name == "hiveId" {
		allowed = s.requireHiveRole(httptest.NewRecorder(), r, *id, edit)
	} else {
		allowed = s.requireApiaryRole(httptest.NewRecorder(), r, *id, edit)
	}
	if !allowed {
		return mcpToolResult{}, errors.New("apiary access denied")
	}
	recorder, err := mcpInvoke(r, handler, id, query, nil)
	if err != nil {
		return mcpToolResult{}, err
	}
	return mcpRecorderResult(recorder)
}

func (s *Server) mcpCallQueenPerformance(
	r *http.Request,
	arguments map[string]json.RawMessage,
) (mcpToolResult, error) {
	apiaryID, err := mcpUUID(arguments, "apiaryId", false)
	if err != nil {
		return mcpToolResult{}, err
	}
	query := url.Values{}
	if apiaryID != nil {
		query.Set("apiaryId", apiaryID.String())
	}
	recorder, err := mcpInvoke(r, s.queenPerformance, nil, query, nil)
	if err != nil {
		return mcpToolResult{}, err
	}
	return mcpRecorderResult(recorder)
}

// mcpCallJSONHandler forwards the tool arguments as the JSON body of a REST
// create handler.
func (s *Server) mcpCallJSONHandler(
	r *http.Request,
	arguments map[string]json.RawMessage,
	handler http.HandlerFunc,
) (mcpToolResult, error) {
	recorder, err := mcpInvoke(r, handler, nil, nil, arguments)
	if err != nil {
		return mcpToolResult{}, err
	}
	return mcpRecorderResult(recorder)
}

type ioNopCloser struct {
	*bytes.Reader
}

func (ioNopCloser) Close() error { return nil }
