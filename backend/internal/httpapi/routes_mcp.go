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
	"strings"

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

func (s *Server) validMCPOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	requestOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}
	appOrigin, err := url.Parse(s.cfg.AppURL)
	if err != nil {
		return false
	}
	return strings.EqualFold(requestOrigin.Scheme, appOrigin.Scheme) &&
		strings.EqualFold(requestOrigin.Host, appOrigin.Host)
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
					"title":   "Beez Trackz",
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

func mcpObject(properties map[string]any, required ...string) map[string]any {
	value := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		value["required"] = required
	}
	return value
}

func mcpTools() []map[string]any {
	stringID := map[string]any{"type": "string", "format": "uuid"}
	return []map[string]any{
		{
			"name":        "list_apiaries",
			"description": "List apiaries visible to the authenticated user.",
			"inputSchema": mcpObject(map[string]any{}),
		},
		{
			"name":        "list_hives",
			"description": "List visible hives, optionally within one apiary.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": stringID}),
		},
		{
			"name":        "get_hive",
			"description": "Get the current details for one visible hive.",
			"inputSchema": mcpObject(map[string]any{"hiveId": stringID}, "hiveId"),
		},
		{
			"name":        "get_hive_timeline",
			"description": "Get the inspection, feeding, treatment, queen, and harvest timeline for one hive.",
			"inputSchema": mcpObject(map[string]any{"hiveId": stringID}, "hiveId"),
		},
		{
			"name":        "get_apiary_weather",
			"description": "Get a ten-day apiary forecast and beekeeping weather alerts.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": stringID}, "apiaryId"),
		},
		{
			"name":        "get_bloom_predictions",
			"description": "Predict local bloom windows from nearby observations and apiary weather.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": stringID}, "apiaryId"),
		},
		{
			"name":        "get_queen_performance",
			"description": "Score queens and queen lines using brood, temperament, yield, and survival records.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": stringID}),
		},
		{
			"name":        "record_inspection",
			"description": "Record an inspection. Requires editor access to the hive's apiary.",
			"inputSchema": mcpObject(map[string]any{
				"hiveId":       stringID,
				"date":         map[string]any{"type": "string", "format": "date"},
				"queenSeen":    map[string]any{"type": "boolean"},
				"broodPattern": map[string]any{"type": "string"},
				"temperament":  map[string]any{"type": "integer", "minimum": 1, "maximum": 5},
				"notes":        map[string]any{"type": "string"},
			}, "hiveId", "date"),
		},
		{
			"name":        "record_feeding",
			"description": "Record feed given to a hive. Requires editor access to the hive's apiary.",
			"inputSchema": mcpObject(map[string]any{
				"hiveId":  stringID,
				"dateFed": map[string]any{"type": "string", "format": "date"},
				"type": map[string]any{
					"type": "string",
					"enum": []string{"sugar_syrup_1to1", "sugar_syrup_2to1", "dry_sugar", "pollen_patty", "fondant", "other"},
				},
				"quantity": map[string]any{"type": "number", "exclusiveMinimum": 0},
				"quantityUnit": map[string]any{
					"type": "string", "enum": []string{"lbs", "oz", "quarts", "gallons"},
				},
				"feederType": map[string]any{"type": "string"},
				"notes":      map[string]any{"type": "string"},
			}, "hiveId", "dateFed", "type", "quantity", "quantityUnit"),
		},
		{
			"name":        "record_mite_count",
			"description": "Record a Varroa mite count. Washes/rolls are mites per 100 bees; sticky boards need daysOnBoard to become mites per day.",
			"inputSchema": mcpObject(map[string]any{
				"hiveId":      stringID,
				"date":        map[string]any{"type": "string", "format": "date"},
				"method":      map[string]any{"type": "string", "enum": []string{"alcohol_wash", "sugar_roll", "sticky_board", "visual"}},
				"mitesCount":  map[string]any{"type": "integer", "minimum": 0},
				"sampleSize":  map[string]any{"type": "integer", "exclusiveMinimum": 0},
				"daysOnBoard": map[string]any{"type": "integer", "exclusiveMinimum": 0},
				"notes":       map[string]any{"type": "string"},
			}, "hiveId", "date", "method", "mitesCount"),
		},
	}
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

func mcpUUID(arguments map[string]json.RawMessage, name string, required bool) (*uuid.UUID, error) {
	raw, ok := arguments[name]
	if !ok {
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

	switch call.Name {
	case "list_apiaries":
		return s.mcpListApiaries(r)
	case "list_hives":
		apiaryID, err := mcpUUID(call.Arguments, "apiaryId", false)
		if err != nil {
			return mcpToolResult{}, err
		}
		return s.mcpListHives(r, apiaryID)
	case "get_hive":
		hiveID, err := mcpUUID(call.Arguments, "hiveId", true)
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
		return s.mcpCallIDHandler(r, call.Arguments, "hiveId", false, s.hiveTimeline)
	case "get_apiary_weather":
		apiaryID, err := mcpUUID(call.Arguments, "apiaryId", true)
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
		return s.mcpCallIDHandler(r, call.Arguments, "apiaryId", false,
			s.apiaryBloomPredictions)
	case "get_queen_performance":
		return s.mcpCallQueenPerformance(r, call.Arguments)
	case "record_inspection":
		return s.mcpCallJSONHandler(r, call.Arguments, s.handleInspectionCreate)
	case "record_feeding":
		return s.mcpCallJSONHandler(r, call.Arguments, s.handleFeedingCreate)
	case "record_mite_count":
		return s.mcpCallJSONHandler(r, call.Arguments, s.miteCountCreate)
	default:
		return mcpToolResult{}, fmt.Errorf("unknown tool %q", call.Name)
	}
}

func (s *Server) mcpListApiaries(r *http.Request) (mcpToolResult, error) {
	user := principalFrom(r)
	rows, err := s.pool.Query(r.Context(), `
		SELECT apiary.id,apiary.name,apiary.latitude,apiary.longitude,
			count(hive.id)::integer
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
		var latitude, longitude *float64
		var hives int
		if err := rows.Scan(&id, &name, &latitude, &longitude, &hives); err != nil {
			return mcpToolResult{}, err
		}
		items = append(items, map[string]any{
			"id": id, "name": name, "latitude": latitude,
			"longitude": longitude, "hiveCount": hives,
		})
	}
	return mcpToolSuccess(items), rows.Err()
}

func (s *Server) mcpListHives(
	r *http.Request,
	apiaryID *uuid.UUID,
) (mcpToolResult, error) {
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
		ORDER BY a.name,h.position_label`, apiaryID, user.IsAdmin, user.ID)
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

func mcpRequestWithID(r *http.Request, id uuid.UUID) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", id.String())
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, routeContext)
	return r.Clone(ctx)
}

func mcpRecorderResult(recorder *httptest.ResponseRecorder) (mcpToolResult, error) {
	if recorder.Code < 200 || recorder.Code >= 300 {
		var value struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &value)
		if value.Error == "" {
			value.Error = fmt.Sprintf("request failed (%d)", recorder.Code)
		}
		return mcpToolResult{}, errors.New(value.Error)
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
	recorder := httptest.NewRecorder()
	handler(recorder, mcpRequestWithID(r, *id))
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
	cloned := r.Clone(r.Context())
	if apiaryID != nil {
		query := cloned.URL.Query()
		query.Set("apiaryId", apiaryID.String())
		cloned.URL.RawQuery = query.Encode()
	}
	recorder := httptest.NewRecorder()
	s.queenPerformance(recorder, cloned)
	return mcpRecorderResult(recorder)
}

func (s *Server) mcpCallJSONHandler(
	r *http.Request,
	arguments map[string]json.RawMessage,
	handler http.HandlerFunc,
) (mcpToolResult, error) {
	body, err := json.Marshal(arguments)
	if err != nil {
		return mcpToolResult{}, err
	}
	cloned := r.Clone(r.Context())
	cloned.Body = http.NoBody
	if len(body) > 0 {
		cloned.Body = ioNopCloser{Reader: bytes.NewReader(body)}
	}
	cloned.Header = r.Header.Clone()
	cloned.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler(recorder, cloned)
	return mcpRecorderResult(recorder)
}

type ioNopCloser struct {
	*bytes.Reader
}

func (ioNopCloser) Close() error { return nil }
