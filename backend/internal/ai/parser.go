package ai

import (
	"context"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// ParsedInspection is one structured inspection extracted from a transcription.
type ParsedInspection struct {
	HiveReference *string     `json:"hiveReference,omitempty"`
	QueenSeen     *bool       `json:"queenSeen,omitempty"`
	QueenHealth   *string     `json:"queenHealth,omitempty"`
	BroodPattern  *string     `json:"broodPattern,omitempty"`
	StoresHoney   *int        `json:"storesHoney,omitempty"`
	StoresPollen  *int        `json:"storesPollen,omitempty"`
	Temperament   *int        `json:"temperament,omitempty"`
	Pests         []Pest      `json:"pests,omitempty"`
	Treatments    []Treatment `json:"treatments,omitempty"`
	Notes         *string     `json:"notes,omitempty"`
}

// Pest and Treatment match the inspections.pests / .treatments jsonb shapes.
type Pest struct {
	Type  string  `json:"type"`
	Count *string `json:"count,omitempty"`
}

type Treatment struct {
	Product string  `json:"product"`
	Method  *string `json:"method,omitempty"`
}

// TranscriptionResult pairs the raw transcription with its parsed inspections.
type TranscriptionResult struct {
	RawText     string             `json:"rawText"`
	Inspections []ParsedInspection `json:"inspections"`
}

// Prompts ported VERBATIM from src/lib/ai/transcription-parser.ts.
const singleModePrompt = `You are a beekeeping inspection data extractor. Given a transcription of a beekeeper describing a hive inspection, extract structured fields.

Return ONLY valid JSON with this exact shape (omit fields that aren't mentioned):
{
  "queenSeen": boolean,
  "queenHealth": "string describing queen condition",
  "broodPattern": "string describing brood pattern",
  "storesHoney": number from 1 to 5,
  "storesPollen": number from 1 to 5,
  "temperament": number from 1 to 5 (1=calm, 5=aggressive),
  "pests": [{"type": "pest name", "count": "optional count or severity"}],
  "treatments": [{"product": "treatment name", "method": "optional application method"}],
  "notes": "any additional observations not captured above"
}

Rules:
- For numeric scales (storesHoney, storesPollen, temperament), interpret qualitative descriptions: "low"=1-2, "medium/moderate"=3, "high/good"=4, "excellent/full"=5
- For queenSeen, look for phrases like "saw the queen", "queen spotted", "couldn't find the queen", "queenless"
- For pests, look for: varroa mites, hive beetles, wax moths, ants, etc.
- For treatments, look for: oxalic acid, formic acid, Apivar, thymol, etc.
- Only include fields that are clearly mentioned or implied in the text
- Return ONLY the JSON object, no markdown, no explanation`

const batchModePrompt = `You are a beekeeping inspection data extractor. Given a transcription of a beekeeper describing inspections of MULTIPLE hives, identify each hive reference and extract structured fields for each.

Return ONLY valid JSON as an array with this exact shape:
[
  {
    "hiveReference": "the identifier used for this hive (e.g. 'hive 1', 'the blue hive', 'number three')",
    "queenSeen": boolean,
    "queenHealth": "string describing queen condition",
    "broodPattern": "string describing brood pattern",
    "storesHoney": number from 1 to 5,
    "storesPollen": number from 1 to 5,
    "temperament": number from 1 to 5 (1=calm, 5=aggressive),
    "pests": [{"type": "pest name", "count": "optional count or severity"}],
    "treatments": [{"product": "treatment name", "method": "optional application method"}],
    "notes": "any additional observations not captured above"
  }
]

Rules:
- First, identify all distinct hive references in the text (e.g. "hive 1", "the blue hive", "number three", "first hive", "next hive")
- Segment the transcription by hive and extract fields for each
- For numeric scales (storesHoney, storesPollen, temperament), interpret qualitative descriptions: "low"=1-2, "medium/moderate"=3, "high/good"=4, "excellent/full"=5
- For queenSeen, look for phrases like "saw the queen", "queen spotted", "couldn't find the queen", "queenless"
- For pests, look for: varroa mites, hive beetles, wax moths, ants, etc.
- For treatments, look for: oxalic acid, formic acid, Apivar, thymol, etc.
- Only include fields that are clearly mentioned or implied
- If a statement applies to all hives (e.g. "treated all hives with oxalic acid"), include it in each hive's data
- Return ONLY the JSON array, no markdown, no explanation`

// BuildPrompt returns the extraction prompt for a mode ("single" or "batch").
func BuildPrompt(mode string) string {
	if mode == "batch" {
		return batchModePrompt
	}
	return singleModePrompt
}

var (
	fenceOpenRe  = regexp.MustCompile("^```(?:json)?[ \\t]*\\n?")
	fenceCloseRe = regexp.MustCompile("\\n?```\\s*$")
)

// sanitizeJSONResponse strips markdown code fences from an AI response.
func sanitizeJSONResponse(text string) string {
	cleaned := strings.TrimSpace(text)
	if strings.HasPrefix(cleaned, "```") {
		cleaned = fenceOpenRe.ReplaceAllString(cleaned, "")
		cleaned = fenceCloseRe.ReplaceAllString(cleaned, "")
	}
	return strings.TrimSpace(cleaned)
}

// stringValue converts a JSON scalar to a string (numbers included), like the
// legacy String(x) coercion for pest counts and treatment methods.
func stringValue(v any) *string {
	switch t := v.(type) {
	case string:
		return &t
	case float64:
		s := strconv.FormatFloat(t, 'f', -1, 64)
		return &s
	case bool:
		s := strconv.FormatBool(t)
		return &s
	default:
		return nil
	}
}

// trimmedString returns a non-empty trimmed string, or nil.
func trimmedString(v any) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

// ratingValue accepts numbers within [1,5], rounded — out-of-range values are
// dropped, matching the legacy validator.
func ratingValue(v any) *int {
	f, ok := v.(float64)
	if !ok || f < 1 || f > 5 {
		return nil
	}
	n := int(math.Round(f))
	return &n
}

// validateParsedInspection ports the legacy field-by-field validator.
func validateParsedInspection(raw map[string]any) ParsedInspection {
	var result ParsedInspection

	if s, ok := raw["hiveReference"].(string); ok {
		result.HiveReference = &s
	}
	if b, ok := raw["queenSeen"].(bool); ok {
		result.QueenSeen = &b
	}
	result.QueenHealth = trimmedString(raw["queenHealth"])
	result.BroodPattern = trimmedString(raw["broodPattern"])
	result.StoresHoney = ratingValue(raw["storesHoney"])
	result.StoresPollen = ratingValue(raw["storesPollen"])
	result.Temperament = ratingValue(raw["temperament"])

	if pests, ok := raw["pests"].([]any); ok {
		out := make([]Pest, 0, len(pests))
		for _, p := range pests {
			m, ok := p.(map[string]any)
			if !ok {
				continue
			}
			typ, ok := m["type"].(string)
			if !ok {
				continue
			}
			pest := Pest{Type: typ}
			if v, exists := m["count"]; exists && v != nil {
				pest.Count = stringValue(v)
			}
			out = append(out, pest)
		}
		result.Pests = out
	}

	if treatments, ok := raw["treatments"].([]any); ok {
		out := make([]Treatment, 0, len(treatments))
		for _, t := range treatments {
			m, ok := t.(map[string]any)
			if !ok {
				continue
			}
			product, ok := m["product"].(string)
			if !ok {
				continue
			}
			treatment := Treatment{Product: product}
			if v, exists := m["method"]; exists && v != nil {
				treatment.Method = stringValue(v)
			}
			out = append(out, treatment)
		}
		result.Treatments = out
	}

	result.Notes = trimmedString(raw["notes"])
	return result
}

// ParseTranscription runs the extraction prompt through the provider and
// validates the response. Invalid JSON from the model yields an empty
// inspection list rather than an error. Single mode tolerates an array
// response (first element taken); batch mode tolerates a lone object.
func ParseTranscription(ctx context.Context, provider Provider, text, mode string) (*TranscriptionResult, error) {
	response, err := provider.Chat(ctx, BuildPrompt(mode), text)
	if err != nil {
		return nil, err
	}
	cleaned := sanitizeJSONResponse(response)

	var parsed any
	if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return &TranscriptionResult{RawText: text, Inspections: []ParsedInspection{}}, nil
	}

	var inspections []ParsedInspection
	if mode == "single" || mode == "" {
		switch v := parsed.(type) {
		case map[string]any:
			inspections = []ParsedInspection{validateParsedInspection(v)}
		case []any:
			if len(v) > 0 {
				if m, ok := v[0].(map[string]any); ok {
					inspections = []ParsedInspection{validateParsedInspection(m)}
				}
			}
		}
	} else {
		switch v := parsed.(type) {
		case []any:
			for _, item := range v {
				if m, ok := item.(map[string]any); ok {
					inspections = append(inspections, validateParsedInspection(m))
				}
			}
		case map[string]any:
			inspections = []ParsedInspection{validateParsedInspection(v)}
		}
	}
	if inspections == nil {
		inspections = []ParsedInspection{}
	}
	return &TranscriptionResult{RawText: text, Inspections: inspections}, nil
}

// HiveRef is the minimal hive shape used for fuzzy reference matching.
type HiveRef struct {
	ID            string `json:"id"`
	PositionLabel string `json:"positionLabel"`
}

// MatchedInspection is a ParsedInspection annotated with a fuzzy hive match.
type MatchedInspection struct {
	ParsedInspection
	MatchedHiveID *string `json:"matchedHiveId,omitempty"`
}

// MatchHiveReferences fuzzy-matches each inspection's hiveReference against
// hive position labels: case-insensitive exact or substring (either direction).
func MatchHiveReferences(inspections []ParsedInspection, hives []HiveRef) []MatchedInspection {
	out := make([]MatchedInspection, 0, len(inspections))
	for _, insp := range inspections {
		matched := MatchedInspection{ParsedInspection: insp}
		if insp.HiveReference != nil {
			ref := strings.ToLower(strings.TrimSpace(*insp.HiveReference))
			for _, h := range hives {
				label := strings.ToLower(h.PositionLabel)
				if ref == label || strings.Contains(ref, label) || strings.Contains(label, ref) {
					id := h.ID
					matched.MatchedHiveID = &id
					break
				}
			}
		}
		out = append(out, matched)
	}
	return out
}
