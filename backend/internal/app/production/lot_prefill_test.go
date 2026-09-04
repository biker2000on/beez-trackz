package production

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func day(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func TestSeasonFor(t *testing.T) {
	cases := map[string]struct {
		in   time.Time
		want string
	}{
		"march starts spring":  {day(2026, time.March, 1), "Spring 2026"},
		"may is spring":        {day(2026, time.May, 31), "Spring 2026"},
		"june starts summer":   {day(2026, time.June, 1), "Summer 2026"},
		"august is summer":     {day(2026, time.August, 31), "Summer 2026"},
		"september is fall":    {day(2026, time.September, 4), "Fall 2026"},
		"november is fall":     {day(2026, time.November, 30), "Fall 2026"},
		"december is winter":   {day(2025, time.December, 15), "Winter 2025"},
		"january is winter":    {day(2026, time.January, 10), "Winter 2026"},
		"february is winter":   {day(2026, time.February, 28), "Winter 2026"},
		"year follows the day": {day(2024, time.July, 4), "Summer 2024"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := SeasonFor(tc.in); got != tc.want {
				t.Fatalf("SeasonFor(%s) = %q, want %q", tc.in.Format("2006-01-02"), got, tc.want)
			}
		})
	}
}

func TestFormatBloomNote(t *testing.T) {
	three := 3
	nine := 9
	last := day(2026, time.June, 20)
	notes := "  heavy along the creek  "
	blank := "   "
	cases := map[string]struct {
		in   BloomObservation
		want string
	}{
		"full": {
			BloomObservation{Species: "Basswood", Abundance: &three, DateFirst: day(2026, time.June, 3), DateLast: &last, Notes: &notes},
			"Basswood (Moderate) — first seen Jun 3, last seen Jun 20 — heavy along the creek",
		},
		"no abundance, no last seen, blank notes": {
			BloomObservation{Species: "Black locust", DateFirst: day(2026, time.May, 12), Notes: &blank},
			"Black locust — first seen May 12",
		},
		"out-of-range abundance keeps the number": {
			BloomObservation{Species: "Clover", Abundance: &nine, DateFirst: day(2026, time.July, 1)},
			"Clover (9) — first seen Jul 1",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := FormatBloomNote(tc.in); got != tc.want {
				t.Fatalf("FormatBloomNote = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFormatBloomNotesJoinsLinesAndIsNilWhenEmpty(t *testing.T) {
	if got := FormatBloomNotes(nil); got != nil {
		t.Fatalf("FormatBloomNotes(nil) = %q, want nil", *got)
	}
	got := FormatBloomNotes([]BloomObservation{
		{Species: "Dandelion", DateFirst: day(2026, time.April, 20)},
		{Species: "Black locust", DateFirst: day(2026, time.May, 12)},
	})
	if got == nil {
		t.Fatal("FormatBloomNotes returned nil for two observations")
	}
	want := "Dandelion — first seen Apr 20\nBlack locust — first seen May 12"
	if *got != want {
		t.Fatalf("FormatBloomNotes = %q, want %q", *got, want)
	}
}

func TestBloomOverlaps(t *testing.T) {
	from, to := day(2026, time.May, 17), day(2026, time.July, 1)
	lastJune := day(2026, time.June, 1)
	cases := map[string]struct {
		first time.Time
		last  *time.Time
		want  bool
	}{
		"inside the window":                 {day(2026, time.June, 3), nil, true},
		"last seen before the window":       {day(2026, time.April, 1), &lastJune, true},
		"default span reaches the window":   {day(2026, time.April, 27), nil, true},
		"default span ends before window":   {day(2026, time.April, 25), nil, false},
		"first seen after the window":       {day(2026, time.July, 2), nil, false},
		"explicit last seen ends too early": {day(2026, time.March, 1), &[]time.Time{day(2026, time.May, 16)}[0], false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := BloomOverlaps(tc.first, tc.last, from, to); got != tc.want {
				t.Fatalf("BloomOverlaps = %v, want %v", got, tc.want)
			}
		})
	}
}

type fakeDrafter struct {
	prompt, context string
	reply           string
	err             error
}

func (f *fakeDrafter) Chat(_ context.Context, prompt, contextText string) (string, error) {
	f.prompt, f.context = prompt, contextText
	return f.reply, f.err
}

func TestBuildStoryContextCarriesOnlyRecordedFacts(t *testing.T) {
	queenSeen := true
	flow := true
	pattern := "solid"
	three := 3
	varietal := "Basswood"
	elevation := 640.1
	notes := "tastes of mint and citrus"
	sc := StoryContext{
		ApiaryName: "Ridge yard", PulledOn: day(2026, time.July, 14), ExtractedOn: day(2026, time.July, 18),
		VarietalName: &varietal, ElevationM: &elevation,
		Inspections: []StoryInspection{
			{Date: day(2026, time.May, 2), HiveName: "H1", QueenSeen: &queenSeen, BroodPattern: &pattern, StoresHoney: &three},
			{Date: day(2026, time.June, 20), HiveName: "H2", FlowOn: &flow, Notes: &notes},
		},
		Harvests: []StoryHarvest{{Date: day(2026, time.July, 14), HiveName: "H1", Pounds: 42.5}},
		Blooms:   []BloomObservation{{Species: "Basswood", Abundance: &three, DateFirst: day(2026, time.June, 25)}},
	}
	text, sources := BuildStoryContext(sc)
	for _, want := range []string{
		"Yard: Ridge yard", "Honey name (varietal): Basswood", "Yard elevation: 640 m",
		"Season: Summer 2026", "Frames pulled: July 14, 2026", "Honey extracted: July 18, 2026",
		"- Basswood (Moderate) — first seen Jun 25",
		"- Jul 14: hive H1, 42.5 lb",
		"- May 2, hive H1: queen seen, brood solid, honey stores 3/5",
		"- Jun 20, hive H2: flow on — tastes of mint and citrus",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("context lacks %q:\n%s", want, text)
		}
	}
	if strings.Index(text, "May 2, hive H1") > strings.Index(text, "Jun 20, hive H2") {
		t.Errorf("inspections are not oldest first:\n%s", text)
	}
	if sources != (StorySources{Inspections: 2, Harvests: 1, BloomObservations: 1}) {
		t.Fatalf("sources = %+v", sources)
	}
}

func TestBuildStoryContextTrimsOldestInspectionsFirst(t *testing.T) {
	long := strings.Repeat("x", 400)
	sc := StoryContext{ApiaryName: "Yard", PulledOn: day(2026, time.July, 14), ExtractedOn: day(2026, time.July, 14)}
	for i := 0; i < 40; i++ {
		sc.Inspections = append(sc.Inspections, StoryInspection{
			Date: day(2026, time.March, 1).AddDate(0, 0, i), HiveName: "H1", Notes: &long,
		})
	}
	text, sources := BuildStoryContext(sc)
	if len(text) > StoryContextLimit {
		t.Fatalf("context is %d chars, cap %d", len(text), StoryContextLimit)
	}
	if sources.Inspections == 0 || sources.Inspections >= 40 {
		t.Fatalf("kept %d inspections, want some but not all", sources.Inspections)
	}
	if !strings.Contains(text, "Apr 9, hive H1") {
		t.Errorf("the newest inspection (Apr 9) was dropped:\n%s", text)
	}
	if strings.Contains(text, "Mar 1, hive H1") {
		t.Errorf("the oldest inspection (Mar 1) survived the cap")
	}
}

func TestDraftStoryUsesPromptAndContext(t *testing.T) {
	drafter := &fakeDrafter{reply: "  I pulled the frames on July 14.  "}
	sc := StoryContext{ApiaryName: "Ridge yard", PulledOn: day(2026, time.July, 14), ExtractedOn: day(2026, time.July, 18)}
	story, sources, err := DraftStory(context.Background(), drafter, sc)
	if err != nil {
		t.Fatal(err)
	}
	if story != "I pulled the frames on July 14." {
		t.Fatalf("story = %q", story)
	}
	if drafter.prompt != StoryPrompt() {
		t.Fatalf("prompt = %q", drafter.prompt)
	}
	for _, want := range []string{"first person", "120-220 words", "Use only facts", "ONLY if a note"} {
		if !strings.Contains(drafter.prompt, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
	if !strings.Contains(drafter.context, "Yard: Ridge yard") || !strings.Contains(drafter.context, "(none recorded)") {
		t.Fatalf("context = %q", drafter.context)
	}
	if sources != (StorySources{}) {
		t.Fatalf("sources = %+v, want empty", sources)
	}

	drafter = &fakeDrafter{reply: "   "}
	if _, _, err := DraftStory(context.Background(), drafter, sc); err == nil {
		t.Fatal("a blank reply was accepted")
	}
	drafter = &fakeDrafter{err: errors.New("boom")}
	if _, _, err := DraftStory(context.Background(), drafter, sc); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("provider error was not surfaced: %v", err)
	}
}
