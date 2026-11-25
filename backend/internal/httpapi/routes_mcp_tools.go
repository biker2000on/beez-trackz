package httpapi

import "sync"

// The MCP tool catalog. Descriptions say what the tool does, how it treats
// duplicates, and the units, because an agent reads nothing else. Every
// object schema sets additionalProperties: false and mcpValidateArguments
// enforces the top level.

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

func mcpUUIDSchema(description string) map[string]any {
	value := map[string]any{"type": "string", "format": "uuid"}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpStringSchema(description string) map[string]any {
	value := map[string]any{"type": "string"}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpDateSchema(description string) map[string]any {
	value := map[string]any{"type": "string", "format": "date"}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpEnumSchema(description string, values ...string) map[string]any {
	value := map[string]any{"type": "string", "enum": values}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpIntSchema(minimum int, description string) map[string]any {
	value := map[string]any{"type": "integer", "minimum": minimum}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpPositiveIntSchema(description string) map[string]any {
	value := map[string]any{"type": "integer", "exclusiveMinimum": 0}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpRatingSchema(description string) map[string]any {
	return map[string]any{
		"type": "integer", "minimum": 1, "maximum": 5, "description": description,
	}
}

func mcpBoolSchema(description string) map[string]any {
	value := map[string]any{"type": "boolean"}
	if description != "" {
		value["description"] = description
	}
	return value
}

func mcpAllowDuplicateSchema() map[string]any {
	return mcpBoolSchema("Write even when a record with the same natural key exists. Default false.")
}

var (
	mcpFeedTypes     = []string{"sugar_syrup_1to1", "sugar_syrup_2to1", "dry_sugar", "pollen_patty", "fondant", "other"}
	mcpFeedUnits     = []string{"lbs", "oz", "quarts", "gallons"}
	mcpFeederTypes   = []string{"entrance", "top", "frame", "baggie", "bucket", "open", "other"}
	mcpMiteMethods   = []string{"alcohol_wash", "sugar_roll", "sticky_board", "visual"}
	mcpQueenEvents   = []string{"observed", "introduced", "superseded", "missing", "dead", "requeened"}
	mcpHiveStatuses  = []string{"active", "dead", "sold", "combined"}
	mcpDateRangeDesc = "Inclusive. to defaults to today and from to 365 days before to; at most 3 years."
)

func mcpMiteCountItemProperties() map[string]any {
	return map[string]any{
		"method":      mcpEnumSchema("", mcpMiteMethods...),
		"mitesCount":  mcpIntSchema(0, "Mites counted."),
		"sampleSize":  mcpPositiveIntSchema("Bees in a wash or roll sample (about 300 for half a cup); mites per 100 bees is derived."),
		"daysOnBoard": mcpPositiveIntSchema("Days a sticky board was in; mites per day is derived. Defaults to 1 for sticky boards."),
		"notes":       mcpStringSchema(""),
	}
}

// mcpInspectionProperties is every inspection field the REST create accepts
// except hiveId, date, and sourceMedia.
func mcpInspectionProperties() map[string]any {
	frames := func(what string) map[string]any {
		return mcpIntSchema(0, "Frames of "+what+" (count).")
	}
	return map[string]any{
		"inspectorName": mcpStringSchema("Who inspected."),
		"queenSeen": mcpBoolSchema(
			"true if the queen was seen, false if looked for and not seen. Omit when unknown; never send false for unknown."),
		"queenHealth":     mcpStringSchema("Free text, for example \"laying well\"."),
		"broodPattern":    mcpStringSchema("Free text, for example \"solid\" or \"spotty\"."),
		"storesHoney":     mcpRatingSchema("Honey stores, 1 (very low) to 5 (full)."),
		"storesPollen":    mcpRatingSchema("Pollen stores, 1 (very low) to 5 (full)."),
		"temperament":     mcpRatingSchema("Temperament: integer 1–5, 1 calm, 5 aggressive."),
		"framesOfBees":    frames("bees"),
		"framesOfBrood":   frames("brood"),
		"framesOfStores":  frames("stores"),
		"crowdedBrood":    mcpBoolSchema("Brood nest crowded (swarm pressure)."),
		"queenCupsCount":  mcpIntSchema(0, "Empty queen cups seen (count)."),
		"queenCellsCount": mcpIntSchema(0, "Charged queen cells seen (count)."),
		"flowOn":          mcpBoolSchema("A nectar flow is on."),
		"pests": map[string]any{
			"type": "array",
			"items": mcpObject(map[string]any{
				"type":  mcpStringSchema("Pest, for example \"small hive beetle\"."),
				"count": mcpStringSchema("How many, as said (\"a few\", \"12\")."),
			}, "type"),
		},
		"treatments": map[string]any{
			"type":        "array",
			"description": "Treatments applied during this inspection; each becomes a treatment record that drives the honey lockout.",
			"items": mcpObject(map[string]any{
				"product": mcpStringSchema("Product name or alias, for example \"Oxalic acid\" or \"Apivar\"."),
				"method":  mcpStringSchema("For example \"vapor\", \"dribble\", \"strips\"."),
			}, "product"),
		},
		"miteCounts": map[string]any{
			"type":        "array",
			"description": "Mite counts taken during this inspection, at most one per method.",
			"items":       mcpObject(mcpMiteCountItemProperties(), "method", "mitesCount"),
		},
		"notes": mcpStringSchema(""),
	}
}

func mcpWithProps(base map[string]any, extra map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(extra))
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func mcpFeedingProperties() map[string]any {
	return map[string]any{
		"type":         mcpEnumSchema("", mcpFeedTypes...),
		"quantity":     map[string]any{"type": "number", "exclusiveMinimum": 0, "description": "Amount fed, in quantityUnit."},
		"quantityUnit": mcpEnumSchema("", mcpFeedUnits...),
		"feederType": mcpEnumSchema(
			"Feeder left on the hive. Omit for feed poured or laid on the frames (recorded as already closed).",
			mcpFeederTypes...),
		"notes": mcpStringSchema(""),
	}
}

func mcpTreatmentProperties() map[string]any {
	return map[string]any{
		"product": mcpStringSchema("Product name or alias, matched to the catalog case-insensitively."),
		"method":  mcpStringSchema("For example \"vapor\", \"dribble\", \"strips\"."),
		"dateRemoved": mcpDateSchema(
			"When the treatment came out (ends the lock). Omitted for a one-shot product such as oxalic acid, it defaults to the application date."),
		"notes": mcpStringSchema(""),
	}
}

var readOnlyTool = map[string]any{"readOnlyHint": true}

func mcpWriteAnnotations(destructive bool) map[string]any {
	return map[string]any{"readOnlyHint": false, "destructiveHint": destructive}
}

func mcpTools() []map[string]any {
	hiveID := mcpUUIDSchema("")
	apiaryID := mcpUUIDSchema("")
	types := map[string]any{
		"type":        "array",
		"description": "Event types to include; empty or omitted means all.",
		"items":       mcpEnumSchema("", activityTypeNames...),
	}

	inspectionCreate := mcpWithProps(mcpInspectionProperties(), map[string]any{
		"hiveId":         hiveID,
		"date":           mcpDateSchema("Inspection date (YYYY-MM-DD)."),
		"allowDuplicate": mcpAllowDuplicateSchema(),
	})
	inspectionUpdate := mcpWithProps(mcpInspectionProperties(), map[string]any{
		"inspectionId": mcpUUIDSchema(""),
		"date":         mcpDateSchema("Move the inspection to this date; its mite counts and treatments move with it."),
	})

	visitEntry := mcpObject(map[string]any{
		"hiveId":        mcpUUIDSchema("The hive. Give hiveId or positionLabel, not both."),
		"positionLabel": mcpStringSchema("Label of the ACTIVE hive in this apiary, case-insensitive, for example \"B4\"."),
		"inspection":    mcpObject(mcpInspectionProperties()),
		"feeding":       mcpObject(mcpFeedingProperties(), "type", "quantity", "quantityUnit"),
		"miteCount":     mcpObject(mcpMiteCountItemProperties(), "method", "mitesCount"),
		"treatment":     mcpObject(mcpTreatmentProperties(), "product"),
	})

	return []map[string]any{
		// --- reads ---
		{
			"name":        "list_apiaries",
			"description": "List apiaries visible to the authenticated user, with active hive counts.",
			"inputSchema": mcpObject(map[string]any{}),
			"annotations": readOnlyTool,
		},
		{
			"name": "list_hives",
			"description": "List visible hives, optionally within one apiary. Defaults to active hives only; " +
				"positionLabel matches exactly (case-insensitive), so a label with the default status returns zero or one hive.",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId": apiaryID,
				"status": mcpEnumSchema(
					"active (default: in the yard now), dead, sold, combined, or all including retired records.",
					mcpHiveStatusFilters...),
				"positionLabel": mcpStringSchema("Exact label, case-insensitive, for example \"A1\"."),
			}),
			"annotations": readOnlyTool,
		},
		{
			"name":        "get_hive",
			"description": "Get the current details for one visible hive.",
			"inputSchema": mcpObject(map[string]any{"hiveId": hiveID}, "hiveId"),
			"annotations": readOnlyTool,
		},
		{
			"name": "get_hive_timeline",
			"description": "Get one hive's events, newest first: inspections, feedings, treatments, mite counts, queen events, " +
				"splits, harvests, moves and (when filtered) status changes. Optional from/to (dates) and types filters.",
			"inputSchema": mcpObject(map[string]any{
				"hiveId": hiveID,
				"from":   mcpDateSchema(mcpDateRangeDesc),
				"to":     mcpDateSchema(""),
				"types":  types,
			}, "hiveId"),
			"annotations": readOnlyTool,
		},
		{
			"name": "get_apiary_activity",
			"description": "Everything recorded in one apiary by day, newest day first: apiary observations, then each hive's events " +
				"(retired hives included). Use it to see what is already recorded for a visit date before writing.",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId": apiaryID,
				"from":     mcpDateSchema(mcpDateRangeDesc),
				"to":       mcpDateSchema(""),
				"types":    types,
			}, "apiaryId"),
			"annotations": readOnlyTool,
		},
		{
			"name":        "list_apiary_observations",
			"description": "List yard-level observations for one apiary, newest first (at most 500), optionally within from/to dates (inclusive).",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId": apiaryID,
				"from":     mcpDateSchema(""),
				"to":       mcpDateSchema(""),
			}, "apiaryId"),
			"annotations": readOnlyTool,
		},
		{
			"name":        "get_apiary_weather",
			"description": "Get a ten-day apiary forecast and beekeeping weather alerts.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": apiaryID}, "apiaryId"),
			"annotations": readOnlyTool,
		},
		{
			"name":        "get_bloom_predictions",
			"description": "Predict local bloom windows from nearby observations and apiary weather.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": apiaryID}, "apiaryId"),
			"annotations": readOnlyTool,
		},
		{
			"name":        "get_queen_performance",
			"description": "Score queens and queen lines using brood, temperament, yield, and survival records.",
			"inputSchema": mcpObject(map[string]any{"apiaryId": apiaryID}),
			"annotations": readOnlyTool,
		},
		{
			"name": "get_varroa_summary",
			"description": "Varroa status per active hive: latest count, whether it is over threshold (washes/rolls in mites per 100 bees, " +
				"boards in mites per day), and treatment efficacy. season (a year) limits treatments and adds that year's counts.",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId": apiaryID,
				"season":   map[string]any{"type": "integer", "minimum": 2000, "maximum": 2200, "description": "Calendar year."},
			}),
			"annotations": readOnlyTool,
		},
		{
			"name": "get_treatment_locks",
			"description": "For each active hive, whether honey is locked by a treatment still in or a withdrawal window, and until when " +
				"(lockoutUntilDate is the first clear day; null while a treatment is still in).",
			"inputSchema": mcpObject(map[string]any{"apiaryId": apiaryID}),
			"annotations": readOnlyTool,
		},

		// --- writes (editor access; deduplicated) ---
		{
			"name": "record_inspection",
			"description": "Record a hive inspection. If the hive already has an inspection on that date nothing is written and " +
				"{duplicate, existingId, record} is returned, unless allowDuplicate is true.",
			"inputSchema": mcpObject(inspectionCreate, "hiveId", "date"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "update_inspection",
			"description": "Change only the given fields of an inspection; null clears a field. treatments and miteCounts replace " +
				"the whole list when given.",
			"inputSchema": mcpObject(inspectionUpdate, "inspectionId"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name":        "delete_inspection",
			"description": "Permanently delete one inspection; the result names the hive and date that were deleted.",
			"inputSchema": mcpObject(map[string]any{"inspectionId": mcpUUIDSchema("")}, "inspectionId"),
			"annotations": mcpWriteAnnotations(true),
		},
		{
			"name": "record_feeding",
			"description": "Record feed given to a hive (quantity in quantityUnit). A feeding of the same type on the same date is " +
				"returned as a duplicate instead of written, unless allowDuplicate is true.",
			"inputSchema": mcpObject(mcpWithProps(mcpFeedingProperties(), map[string]any{
				"hiveId":         hiveID,
				"dateFed":        mcpDateSchema(""),
				"feederType":     mcpEnumSchema("Feeder left on the hive; omit for feed poured or laid on the frames.", mcpFeederTypes...),
				"allowDuplicate": mcpAllowDuplicateSchema(),
			}), "hiveId", "dateFed", "type", "quantity", "quantityUnit"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "record_mite_count",
			"description": "Record a Varroa mite count. Washes/rolls are mites per 100 bees; sticky boards need daysOnBoard to become " +
				"mites per day. A count with the same method on the same date is returned as a duplicate unless allowDuplicate is true.",
			"inputSchema": mcpObject(mcpWithProps(mcpMiteCountItemProperties(), map[string]any{
				"hiveId":         hiveID,
				"date":           mcpDateSchema(""),
				"allowDuplicate": mcpAllowDuplicateSchema(),
			}), "hiveId", "date", "method", "mitesCount"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "record_treatment",
			"description": "Record a mite treatment; it locks the hive's honey until dateRemoved plus the product's withdrawal days. " +
				"One-shot products (oxalic acid) default dateRemoved to dateApplied. Same product on the same date is a duplicate unless allowDuplicate is true.",
			"inputSchema": mcpObject(mcpWithProps(mcpTreatmentProperties(), map[string]any{
				"hiveId":         hiveID,
				"dateApplied":    mcpDateSchema(""),
				"allowDuplicate": mcpAllowDuplicateSchema(),
			}), "hiveId", "dateApplied", "product"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "record_queen_event",
			"description": "Record a queen event (seen, introduced, superseded, missing, dead, requeened). The same event type on " +
				"the same date is a duplicate unless allowDuplicate is true.",
			"inputSchema": mcpObject(map[string]any{
				"hiveId":         hiveID,
				"eventDate":      mcpDateSchema(""),
				"eventType":      mcpEnumSchema("", mcpQueenEvents...),
				"queenId":        mcpUUIDSchema("Queen record, if known."),
				"notes":          mcpStringSchema(""),
				"allowDuplicate": mcpAllowDuplicateSchema(),
			}, "hiveId", "eventDate", "eventType"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "record_apiary_observation",
			"description": "Record a yard-level observation (forage, weather, the whole apiary). An observation with the same time " +
				"and text is a duplicate unless allowDuplicate is true.",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId": apiaryID,
				"observedAt": map[string]any{"type": "string", "format": "date-time",
					"description": "When it was observed (RFC 3339, or a date for midnight)."},
				"notes":          mcpStringSchema(""),
				"allowDuplicate": mcpAllowDuplicateSchema(),
			}, "apiaryId", "observedAt", "notes"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "record_bloom_observation",
			"description": "Record a plant first seen in bloom near an apiary (abundance 1 sparse to 5 abundant, elevation in meters). " +
				"The same species on the same date is a duplicate unless allowDuplicate is true.",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId":       apiaryID,
				"species":        mcpStringSchema("Common or botanical name."),
				"dateFirstSeen":  mcpDateSchema(""),
				"abundance":      mcpRatingSchema("1 (sparse) to 5 (abundant)."),
				"notes":          mcpStringSchema(""),
				"elevationM":     map[string]any{"type": "number", "minimum": -500, "maximum": 9000, "description": "Meters; defaults to the apiary pin."},
				"allowDuplicate": mcpAllowDuplicateSchema(),
			}, "apiaryId", "species", "dateFirstSeen"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "set_hive_status",
			"description": "Change only a hive's status. dead archives it and records the dead-out date (date or today); sold and " +
				"combined archive it; active unarchives it and clears the dead-out date. Notes, label and slot are untouched.",
			"inputSchema": mcpObject(map[string]any{
				"hiveId": hiveID,
				"status": mcpEnumSchema("", mcpHiveStatuses...),
				"date":   mcpDateSchema("Dead-out date for status dead; ignored otherwise."),
			}, "hiveId", "status"),
			"annotations": mcpWriteAnnotations(false),
		},
		{
			"name": "record_visit",
			"description": "Record a whole-yard visit in one call: an optional yard observation plus, per hive, an inspection, feeding, " +
				"mite count and/or treatment, all dated date. Each entry is saved on its own with the per-record duplicate rules; " +
				"the result lists what was created, skipped as duplicate, or failed per entry, with totals.",
			"inputSchema": mcpObject(map[string]any{
				"apiaryId":       apiaryID,
				"date":           mcpDateSchema("Visit date (YYYY-MM-DD), not in the future."),
				"observation":    mcpStringSchema("Yard-level notes for the visit, saved as an apiary observation at the start of date."),
				"allowDuplicate": mcpAllowDuplicateSchema(),
				"entries": map[string]any{
					"type":     "array",
					"maxItems": mcpVisitMaxEntries,
					"items":    visitEntry,
				},
			}, "apiaryId", "date"),
			"annotations": mcpWriteAnnotations(false),
		},
	}
}

var (
	mcpToolIndexOnce sync.Once
	mcpToolIndexMap  map[string]map[string]any
)

// mcpToolIndex is the catalog keyed by tool name, built once.
func mcpToolIndex() map[string]map[string]any {
	mcpToolIndexOnce.Do(func() {
		mcpToolIndexMap = map[string]map[string]any{}
		for _, tool := range mcpTools() {
			name, _ := tool["name"].(string)
			mcpToolIndexMap[name] = tool
		}
	})
	return mcpToolIndexMap
}
