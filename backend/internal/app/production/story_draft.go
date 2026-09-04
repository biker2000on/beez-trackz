package production

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// StoryContextLimit caps the assembled context handed to the model. The
// fixed sections (yard, dates, bloom, harvests) are always kept; inspections
// fill the rest newest-first, so a long season loses its earliest visits.
const StoryContextLimit = 6000

// StoryDrafter is the one provider method the beekeeper story needs. It is
// satisfied by ai.Provider and by any test fake.
type StoryDrafter interface {
	Chat(ctx context.Context, prompt, context string) (string, error)
}

// StoryInspection is one inspection of a hive in the lot's yard.
type StoryInspection struct {
	Date         time.Time
	HiveName     string
	QueenSeen    *bool
	BroodPattern *string
	StoresHoney  *int
	StoresPollen *int
	Temperament  *int
	FlowOn       *bool
	Notes        *string
}

// StoryHarvest is one honey_harvests row (with its session's notes) in the
// pull-to-extraction window.
type StoryHarvest struct {
	Date         time.Time
	HiveName     string
	Pounds       float64
	SessionNotes *string
	Notes        *string
}

// StoryContext is everything the draft may say. Nothing outside it is a fact
// the prompt allows the model to use.
type StoryContext struct {
	ApiaryName   string
	PulledOn     time.Time
	ExtractedOn  time.Time
	VarietalName *string
	ElevationM   *float64
	Inspections  []StoryInspection
	Harvests     []StoryHarvest
	Blooms       []BloomObservation
}

// StorySources counts what actually made it into the context after the cap.
type StorySources struct {
	Inspections       int `json:"inspections"`
	Harvests          int `json:"harvests"`
	BloomObservations int `json:"bloomObservations"`
	WeatherDays       int `json:"weatherDays"`
}

// StoryPrompt is the instruction the draft is written under.
func StoryPrompt() string {
	return strings.TrimSpace(`
You are a beekeeper writing the short story that goes on a honey label and its public "Honey Story" page.
Write in the first person, plain language, warm but not flowery, 120-220 words, in two or three short paragraphs.
Use only facts that appear in the context below. Do not invent flowers, weather, dates, places, or events that are not there.
Mention the yard by name, what was in bloom, anything notable that happened to the colonies during the season, and the dates the frames were pulled and the honey was extracted.
End with how the honey tastes ONLY if a note in the context describes its taste; otherwise do not mention flavor at all.
Do not use headings, bullet points, quotation marks around the whole text, or a title. Return only the story text.`)
}

// BuildStoryContext assembles the context text and reports what it holds.
func BuildStoryContext(sc StoryContext) (string, StorySources) {
	var fixed strings.Builder
	sources := StorySources{}
	fmt.Fprintf(&fixed, "Yard: %s\n", strings.TrimSpace(sc.ApiaryName))
	if sc.VarietalName != nil && strings.TrimSpace(*sc.VarietalName) != "" {
		fmt.Fprintf(&fixed, "Honey name (varietal): %s\n", strings.TrimSpace(*sc.VarietalName))
	}
	if sc.ElevationM != nil {
		fmt.Fprintf(&fixed, "Yard elevation: %.0f m\n", *sc.ElevationM)
	}
	fmt.Fprintf(&fixed, "Season: %s\n", SeasonFor(sc.ExtractedOn))
	fmt.Fprintf(&fixed, "Frames pulled: %s\n", sc.PulledOn.Format("January 2, 2006"))
	fmt.Fprintf(&fixed, "Honey extracted: %s\n", sc.ExtractedOn.Format("January 2, 2006"))

	fixed.WriteString("\nBloom observed at this yard this season:\n")
	if len(sc.Blooms) == 0 {
		fixed.WriteString("(none recorded)\n")
	}
	for _, bloom := range sc.Blooms {
		fixed.WriteString("- " + FormatBloomNote(bloom) + "\n")
		sources.BloomObservations++
	}

	fixed.WriteString("\nHarvests in this lot's window:\n")
	if len(sc.Harvests) == 0 {
		fixed.WriteString("(none recorded)\n")
	}
	for _, harvest := range sc.Harvests {
		fmt.Fprintf(&fixed, "- %s: hive %s, %.1f lb", formatMonthDay(harvest.Date), harvest.HiveName, harvest.Pounds)
		if note := trimmedNote(harvest.Notes); note != "" {
			fixed.WriteString(" — " + note)
		}
		if note := trimmedNote(harvest.SessionNotes); note != "" {
			fixed.WriteString(" — session: " + note)
		}
		fixed.WriteString("\n")
		sources.Harvests++
	}

	fixed.WriteString("\nInspections this season (oldest first):\n")
	budget := StoryContextLimit - fixed.Len()
	inspections := append([]StoryInspection(nil), sc.Inspections...)
	sort.SliceStable(inspections, func(i, j int) bool { return inspections[i].Date.After(inspections[j].Date) })
	kept := make([]string, 0, len(inspections))
	for _, inspection := range inspections {
		line := "- " + formatInspection(inspection) + "\n"
		if len(line) > budget {
			break
		}
		budget -= len(line)
		kept = append(kept, line)
	}
	if len(kept) == 0 {
		fixed.WriteString("(none recorded)\n")
	}
	for index := len(kept) - 1; index >= 0; index-- {
		fixed.WriteString(kept[index])
	}
	sources.Inspections = len(kept)
	return fixed.String(), sources
}

func formatInspection(inspection StoryInspection) string {
	parts := []string{}
	if inspection.QueenSeen != nil {
		if *inspection.QueenSeen {
			parts = append(parts, "queen seen")
		} else {
			parts = append(parts, "queen not seen")
		}
	}
	if pattern := trimmedNote(inspection.BroodPattern); pattern != "" {
		parts = append(parts, "brood "+pattern)
	}
	if inspection.StoresHoney != nil {
		parts = append(parts, fmt.Sprintf("honey stores %d/5", *inspection.StoresHoney))
	}
	if inspection.StoresPollen != nil {
		parts = append(parts, fmt.Sprintf("pollen stores %d/5", *inspection.StoresPollen))
	}
	if inspection.Temperament != nil {
		parts = append(parts, fmt.Sprintf("temperament %d/5", *inspection.Temperament))
	}
	if inspection.FlowOn != nil {
		if *inspection.FlowOn {
			parts = append(parts, "flow on")
		} else {
			parts = append(parts, "no flow")
		}
	}
	line := fmt.Sprintf("%s, hive %s", formatMonthDay(inspection.Date), inspection.HiveName)
	if len(parts) > 0 {
		line += ": " + strings.Join(parts, ", ")
	}
	if note := trimmedNote(inspection.Notes); note != "" {
		line += " — " + note
	}
	return line
}

func trimmedNote(note *string) string {
	if note == nil {
		return ""
	}
	return strings.Join(strings.Fields(*note), " ")
}

// DraftStory asks the drafter for the story and returns it trimmed. A blank
// answer is an error: the client would otherwise overwrite the field with
// nothing.
func DraftStory(ctx context.Context, drafter StoryDrafter, sc StoryContext) (string, StorySources, error) {
	contextText, sources := BuildStoryContext(sc)
	story, err := drafter.Chat(ctx, StoryPrompt(), contextText)
	if err != nil {
		return "", sources, err
	}
	story = strings.TrimSpace(story)
	if story == "" {
		return "", sources, errors.New("the AI provider returned an empty story")
	}
	return story, sources, nil
}
