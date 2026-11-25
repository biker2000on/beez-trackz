package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var expectedMCPTools = []string{
	"list_apiaries", "list_hives", "get_hive", "get_hive_timeline",
	"get_apiary_activity", "list_apiary_observations", "get_apiary_weather",
	"get_bloom_predictions", "get_queen_performance", "get_varroa_summary",
	"get_treatment_locks",
	"record_inspection", "update_inspection", "delete_inspection",
	"record_feeding", "record_mite_count", "record_treatment",
	"record_queen_event", "record_apiary_observation", "record_bloom_observation",
	"set_hive_status", "record_visit",
}

// checkClosedSchema walks a JSON schema and fails on any object that does
// not set additionalProperties: false or that requires an undeclared key.
func checkClosedSchema(t *testing.T, path string, schema map[string]any) {
	t.Helper()
	switch schema["type"] {
	case "object":
		if schema["additionalProperties"] != false {
			t.Errorf("%s: additionalProperties must be false", path)
		}
		properties, _ := schema["properties"].(map[string]any)
		required, _ := schema["required"].([]string)
		for _, key := range required {
			if _, ok := properties[key]; !ok {
				t.Errorf("%s: required %q is not a property", path, key)
			}
		}
		for key, value := range properties {
			child, ok := value.(map[string]any)
			if !ok {
				t.Errorf("%s.%s: property schema is not an object", path, key)
				continue
			}
			checkClosedSchema(t, path+"."+key, child)
		}
	case "array":
		if items, ok := schema["items"].(map[string]any); ok {
			checkClosedSchema(t, path+"[]", items)
		}
	}
	if values, ok := schema["enum"].([]string); ok && len(values) == 0 {
		t.Errorf("%s: empty enum", path)
	}
}

func TestMCPToolCatalogIsCompleteAndClosed(t *testing.T) {
	tools := mcpTools()
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		names = append(names, name)
		description, _ := tool["description"].(string)
		if strings.TrimSpace(description) == "" {
			t.Errorf("%s: missing description", name)
		}
		schema, ok := tool["inputSchema"].(map[string]any)
		if !ok {
			t.Fatalf("%s: missing inputSchema", name)
		}
		checkClosedSchema(t, name, schema)
		if _, ok := tool["annotations"].(map[string]any); !ok {
			t.Errorf("%s: missing annotations", name)
		}
		if strings.HasPrefix(name, "record_") {
			if !strings.Contains(strings.ToLower(description), "duplicate") {
				t.Errorf("%s: description must state the dedupe behaviour", name)
			}
			properties := schema["properties"].(map[string]any)
			if _, ok := properties["allowDuplicate"]; !ok {
				t.Errorf("%s: missing allowDuplicate", name)
			}
		}
	}
	got := append([]string(nil), names...)
	want := append([]string(nil), expectedMCPTools...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v\nwant %v", got, want)
	}
	if _, err := json.Marshal(tools); err != nil {
		t.Fatalf("catalog does not marshal: %v", err)
	}
}

func TestMCPRecordInspectionExposesEveryCreateField(t *testing.T) {
	properties := mcpToolIndex()["record_inspection"]["inputSchema"].(map[string]any)["properties"].(map[string]any)
	for _, field := range []string{
		"hiveId", "date", "inspectorName", "queenSeen", "queenHealth", "broodPattern",
		"storesHoney", "storesPollen", "temperament", "framesOfBees", "framesOfBrood",
		"framesOfStores", "crowdedBrood", "queenCupsCount", "queenCellsCount", "flowOn",
		"pests", "treatments", "miteCounts", "notes", "allowDuplicate",
	} {
		if _, ok := properties[field]; !ok {
			t.Errorf("record_inspection is missing %q", field)
		}
	}
	queenSeen := properties["queenSeen"].(map[string]any)
	if queenSeen["type"] != "boolean" {
		t.Fatalf("queenSeen must stay a plain boolean (omitted = unknown): %v", queenSeen)
	}
	required := mcpToolIndex()["record_inspection"]["inputSchema"].(map[string]any)["required"].([]string)
	for _, key := range required {
		if key == "queenSeen" {
			t.Fatal("queenSeen must not be required")
		}
	}
}

func TestMCPToolsListOverJSONRPC(t *testing.T) {
	server := &Server{}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`))
	response := httptest.NewRecorder()
	server.mcpPost(response, request)
	var body struct {
		Result struct {
			Tools []map[string]any `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Result.Tools) != len(expectedMCPTools) {
		t.Fatalf("tools/list returned %d tools, want %d", len(body.Result.Tools), len(expectedMCPTools))
	}
}

func TestMCPValidateArguments(t *testing.T) {
	raw := func(values map[string]any) map[string]json.RawMessage {
		out := map[string]json.RawMessage{}
		for key, value := range values {
			out[key], _ = json.Marshal(value)
		}
		return out
	}
	hive := uuid.NewString()
	cases := []struct {
		name string
		tool string
		args map[string]any
		want string
	}{
		{"ok", "record_inspection", map[string]any{"hiveId": hive, "date": "2026-09-13"}, ""},
		{"unknown", "record_inspection", map[string]any{"hiveId": hive, "date": "2026-09-13", "colour": "red"},
			"unknown argument(s) for record_inspection: colour"},
		{"missing", "record_inspection", map[string]any{"hiveId": hive}, "date is required"},
		{"null required", "record_feeding", map[string]any{
			"hiveId": hive, "dateFed": nil, "type": "fondant", "quantity": 1, "quantityUnit": "lbs",
		}, "dateFed is required"},
		{"unknown tool", "make_honey", map[string]any{}, `unknown tool "make_honey"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := mcpValidateArguments(tc.tool, raw(tc.args))
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// callToolNoDB invokes tools/call on a server without a database. Every case
// here must fail validation before any query runs.
func callToolNoDB(t *testing.T, name string, args any) mcpToolResult {
	t.Helper()
	params, _ := json.Marshal(map[string]any{"name": name, "arguments": args})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/mcp", nil)
	result, err := (&Server{}).mcpCallTool(request, params)
	if err != nil {
		return mcpToolError(err.Error())
	}
	return result
}

func TestMCPArgumentErrorsNeedNoDatabase(t *testing.T) {
	apiary := uuid.NewString()
	cases := []struct {
		name string
		tool string
		args map[string]any
		want string
	}{
		{"list_hives bad status", "list_hives", map[string]any{"status": "zombie"}, "status must be one of"},
		{"timeline bad type", "get_hive_timeline", map[string]any{"hiveId": uuid.NewString(), "types": []string{"weather"}}, "unknown type"},
		{"activity bad date", "get_apiary_activity", map[string]any{"apiaryId": apiary, "from": "13/09/2026"}, "from must be a date"},
		{"visit nested unknown field", "record_visit", map[string]any{
			"apiaryId": apiary, "date": "2026-09-13",
			"entries": []any{map[string]any{"positionLabel": "A1", "inspection": map[string]any{"hiveId": "x"}}},
		}, `unknown field "hiveId"`},
		{"visit future", "record_visit", map[string]any{
			"apiaryId": apiary, "date": time.Now().AddDate(0, 0, 3).Format(civilDateLayout), "observation": "x",
		}, "date cannot be in the future"},
		{"visit empty", "record_visit", map[string]any{"apiaryId": apiary, "date": "2026-09-13"},
			"give an observation or at least one entry"},
		{"visit bad date", "record_visit", map[string]any{"apiaryId": apiary, "date": "2026-9-13", "observation": "x"},
			"date must be a date"},
		{"inspection bad date", "record_inspection", map[string]any{"hiveId": uuid.NewString(), "date": "soon"},
			"date must be a date"},
		{"treatment removed before applied", "record_treatment", map[string]any{
			"hiveId": uuid.NewString(), "dateApplied": "2026-10-02", "dateRemoved": "2026-10-01", "product": "Apivar",
		}, "dateRemoved must be on or after dateApplied"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := callToolNoDB(t, tc.tool, tc.args)
			if !result.IsError {
				t.Fatalf("expected an error result, got %+v", result)
			}
			text, _ := result.Content[0]["text"].(string)
			if !strings.Contains(text, tc.want) {
				t.Fatalf("error %q does not contain %q", text, tc.want)
			}
		})
	}
}

func TestMCPVisitTooManyEntries(t *testing.T) {
	entries := make([]any, mcpVisitMaxEntries+1)
	for i := range entries {
		entries[i] = map[string]any{"positionLabel": "A1"}
	}
	args := map[string]json.RawMessage{}
	args["apiaryId"], _ = json.Marshal(uuid.NewString())
	args["date"], _ = json.Marshal("2026-09-13")
	args["entries"], _ = json.Marshal(entries)
	if _, err := decodeMCPVisit(args, time.Now()); err == nil ||
		!strings.Contains(err.Error(), "at most") {
		t.Fatalf("err = %v", err)
	}
}

func TestMCPVisitEntryTarget(t *testing.T) {
	id := uuid.New()
	idText := id.String()
	label := " b4 "
	blank := "  "
	bad := "nope"
	cases := []struct {
		name    string
		entry   mcpVisitEntry
		wantID  *uuid.UUID
		wantLbl string
		wantErr string
	}{
		{"id", mcpVisitEntry{HiveID: &idText}, &id, "", ""},
		{"label", mcpVisitEntry{PositionLabel: &label}, nil, "b4", ""},
		{"both", mcpVisitEntry{HiveID: &idText, PositionLabel: &label}, nil, "", "not both"},
		{"neither", mcpVisitEntry{PositionLabel: &blank}, nil, "", "hiveId or positionLabel is required"},
		{"bad id", mcpVisitEntry{HiveID: &bad}, nil, "", "hiveId must be a UUID"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotID, gotLabel, err := mcpVisitEntryTarget(tc.entry)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (gotID == nil) != (tc.wantID == nil) || (gotID != nil && *gotID != *tc.wantID) || gotLabel != tc.wantLbl {
				t.Fatalf("got %v %q", gotID, gotLabel)
			}
		})
	}
}

func TestResolveVisitHiveUsesActiveHivesOnly(t *testing.T) {
	active := mcpVisitHive{ID: uuid.New(), Label: "A1", IsActive: true}
	retired := mcpVisitHive{ID: uuid.New(), Label: "A1", IsActive: false}
	twinA := mcpVisitHive{ID: uuid.New(), Label: "C2", IsActive: true}
	twinB := mcpVisitHive{ID: uuid.New(), Label: "c2", IsActive: true}
	hives := []mcpVisitHive{retired, active, twinA, twinB}

	got, err := resolveVisitHive(hives, nil, "a1")
	if err != nil || got.ID != active.ID {
		t.Fatalf("label resolved to %+v, %v; want the active A1", got, err)
	}
	if _, err := resolveVisitHive(hives, nil, "D4"); err == nil ||
		!strings.Contains(err.Error(), "no active hive") {
		t.Fatalf("unknown label err = %v", err)
	}
	if _, err := resolveVisitHive(hives, nil, "C2"); err == nil ||
		!strings.Contains(err.Error(), "give hiveId") {
		t.Fatalf("ambiguous label err = %v", err)
	}
	// An explicit id is taken as given, retired or not, if it is in the apiary.
	if got, err := resolveVisitHive(hives, &retired.ID, ""); err != nil || got.ID != retired.ID {
		t.Fatalf("explicit id = %+v, %v", got, err)
	}
	other := uuid.New()
	if _, err := resolveVisitHive(hives, &other, ""); err == nil {
		t.Fatal("a hive from another apiary must be refused")
	}
}

func TestPrepareVisitEntryValidatesEachRecord(t *testing.T) {
	visit := mcpVisit{mcpVisitRequest: mcpVisitRequest{Date: "2026-09-13"}}
	visit.Day, _ = parseCivilDate("2026-09-13")
	visit.At, _ = parseDate("2026-09-13")
	hive := uuid.New()
	negative := -1
	six := 6
	quantity := 2.0
	bogus := "bogus"
	early := "2026-09-01"

	_, issues := prepareVisitEntry(mcpVisitEntry{}, hive, visit)
	if len(issues) != 1 || issues[0].Kind != "entry" {
		t.Fatalf("empty entry issues = %+v", issues)
	}

	_, issues = prepareVisitEntry(mcpVisitEntry{
		Inspection: &mcpInspectionInput{FramesOfBees: &negative},
		Feeding:    &mcpVisitFeeding{Type: bogus, Quantity: &quantity, QuantityUnit: "lbs"},
		MiteCount:  &mcpVisitMiteCount{Method: "alcohol_wash"},
		Treatment:  &mcpVisitTreatment{Product: "Apivar", DateRemoved: &early},
	}, hive, visit)
	kinds := map[string]string{}
	for _, issue := range issues {
		kinds[issue.Kind] = issue.Error
	}
	if kinds["inspection"] != "framesOfBees cannot be negative" ||
		kinds["feeding"] != "Invalid feed type" ||
		kinds["miteCount"] != "mitesCount is required" ||
		kinds["treatment"] != "dateRemoved must be on or after the visit date" {
		t.Fatalf("issues = %+v", issues)
	}

	plan, issues := prepareVisitEntry(mcpVisitEntry{
		Inspection: &mcpInspectionInput{Notes: strPtr("calm, queen seen")},
		Feeding:    &mcpVisitFeeding{Type: "sugar_syrup_1to1", Quantity: &quantity, QuantityUnit: "quarts"},
		MiteCount:  &mcpVisitMiteCount{Method: "sticky_board", MitesCount: &six},
		Treatment:  &mcpVisitTreatment{Product: " Oxalic acid "},
	}, hive, visit)
	if len(issues) != 0 {
		t.Fatalf("valid entry issues = %+v", issues)
	}
	if plan.inspection == nil || plan.feeding == nil || plan.miteCount == nil || plan.treatment == nil {
		t.Fatalf("plan incomplete: %+v", plan)
	}
	if plan.inspectionFields.QueenSeen != nil {
		t.Fatal("queenSeen must stay unknown when omitted")
	}
	if plan.miteCount.DaysOnBoard == nil || *plan.miteCount.DaysOnBoard != 1 {
		t.Fatalf("sticky board days defaulted wrong: %+v", plan.miteCount)
	}
	if plan.treatment.Product != "Oxalic acid" || !plan.treatmentDefault || plan.treatment.DateRemoved != nil {
		t.Fatalf("treatment plan = %+v default=%v", plan.treatment, plan.treatmentDefault)
	}
	if !plan.feeding.DateFed.Equal(visit.At) || plan.feeding.FeederType != nil {
		t.Fatalf("feeding plan = %+v", plan.feeding)
	}
}

func TestMCPParseHiveStatusFilter(t *testing.T) {
	if got, err := mcpParseHiveStatusFilter(nil); err != nil || got != "active" {
		t.Fatalf("default = %q %v", got, err)
	}
	all := " ALL "
	if got, err := mcpParseHiveStatusFilter(&all); err != nil || got != "all" {
		t.Fatalf("all = %q %v", got, err)
	}
	bad := "archived"
	if _, err := mcpParseHiveStatusFilter(&bad); err == nil {
		t.Fatal("archived is not a status")
	}
}
