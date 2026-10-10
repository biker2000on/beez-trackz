package sales

import (
	"testing"

	"github.com/google/uuid"
)

func TestChooseJarLineLot(t *testing.T) {
	line, run, sale := uuid.New(), uuid.New(), uuid.New()
	tests := map[string]struct {
		lineLot, runLot uuid.UUID
		saleLot         *uuid.UUID
		want            uuid.UUID
		problem         string
	}{
		"line lot wins":               {lineLot: line, saleLot: &sale, want: line},
		"line lot agrees with run":    {lineLot: run, runLot: run, want: run},
		"line lot disagrees with run": {lineLot: line, runLot: run, problem: "bottlingRunId does not belong to harvestLotId"},
		"run names the lot":           {runLot: run, saleLot: &sale, want: run},
		"sale lends its lot":          {saleLot: &sale, want: sale},
		"no lot anywhere is refused":  {problem: ErrJarLineNeedsLot},
		"nil sale lot is no lot":      {saleLot: &uuid.Nil, problem: ErrJarLineNeedsLot},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			got, problem := chooseJarLineLot(tc.lineLot, tc.runLot, tc.saleLot)
			if problem != tc.problem {
				t.Fatalf("problem = %q, want %q", problem, tc.problem)
			}
			if got != tc.want {
				t.Fatalf("lot = %s, want %s", got, tc.want)
			}
		})
	}
}
