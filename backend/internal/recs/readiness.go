package recs

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ReadinessCall is the derived field call for one active hive. It is evidence,
// not another inspection record.
type ReadinessCall struct {
	HiveID             string   `json:"hiveId"`
	HiveName           string   `json:"hiveName"`
	ApiaryID           string   `json:"apiaryId"`
	ApiaryName         string   `json:"apiaryName"`
	Call               string   `json:"call"` // will_swarm | ready_to_split | neither
	Evidence           []string `json:"evidence"`
	DaysSinceLastSplit *int     `json:"daysSinceLastSplit"`
}

type readinessEvidence struct {
	CrowdedBrood   *bool
	QueenCups      *int
	QueenCells     *int
	FramesOfBees   *int
	FramesOfBrood  *int
	FramesOfStores *int
	StoresHoney    *int
	FlowOn         *bool
	Temperament    *int
	DaysSinceSplit *int
}

func deriveReadiness(v readinessEvidence) (string, []string) {
	evidence := []string{}
	crowded := v.CrowdedBrood != nil && *v.CrowdedBrood
	queenCells := v.QueenCells != nil && *v.QueenCells > 0
	queenCups := v.QueenCups != nil && *v.QueenCups > 0
	strongBees := v.FramesOfBees != nil && *v.FramesOfBees >= 8
	strongBrood := v.FramesOfBrood != nil && *v.FramesOfBrood >= 5
	storesReady := (v.FramesOfStores != nil && *v.FramesOfStores >= 2) ||
		(v.StoresHoney != nil && *v.StoresHoney >= 3)
	flow := v.FlowOn != nil && *v.FlowOn
	temperamentOK := v.Temperament == nil || *v.Temperament >= 3
	recentSplit := v.DaysSinceSplit != nil && *v.DaysSinceSplit < 30

	if crowded {
		evidence = append(evidence, "crowded brood nest")
	}
	if queenCells {
		evidence = append(evidence, fmt.Sprintf("%d queen cells", *v.QueenCells))
	}
	if queenCups {
		evidence = append(evidence, fmt.Sprintf("%d queen cups", *v.QueenCups))
	}
	if strongBees {
		evidence = append(evidence, fmt.Sprintf("%d frames of bees", *v.FramesOfBees))
	}
	if strongBrood {
		evidence = append(evidence, fmt.Sprintf("%d frames of brood", *v.FramesOfBrood))
	}
	if storesReady {
		evidence = append(evidence, "adequate stores")
	}
	if flow {
		evidence = append(evidence, "nectar flow on")
	}
	if recentSplit {
		evidence = append(evidence, fmt.Sprintf("split %d days ago", *v.DaysSinceSplit))
	}

	if queenCells && (crowded || strongBees || strongBrood) {
		return "will_swarm", evidence
	}
	if !recentSplit && temperamentOK && storesReady && (crowded || (strongBees && strongBrood)) &&
		(flow || queenCups) {
		return "ready_to_split", evidence
	}
	return "neither", evidence
}

// SwarmSplitReadiness derives one current call per visible active hive.
func SwarmSplitReadiness(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]ReadinessCall, error) {
	rows, err := pool.Query(ctx, `
		SELECT h.id, h.position_label, a.id, a.name,
		       i.crowded_brood, i.queen_cups_count, i.queen_cells_count,
		       i.frames_of_bees, i.frames_of_brood, i.frames_of_stores,
		       i.stores_honey, i.flow_on, i.temperament,
		       CASE WHEN sp.last_split IS NULL THEN NULL
		            ELSE GREATEST(0, ($1::date - sp.last_split::date))::int END
		FROM hives h
		JOIN apiaries a ON a.id=h.apiary_id
		LEFT JOIN LATERAL (
			SELECT crowded_brood, queen_cups_count, queen_cells_count,
			       frames_of_bees, frames_of_brood, frames_of_stores,
			       stores_honey, flow_on, temperament
			FROM inspections WHERE hive_id=h.id ORDER BY date DESC LIMIT 1
		) i ON true
		LEFT JOIN LATERAL (
			SELECT max(split_date) last_split FROM hive_splits WHERE parent_hive_id=h.id
		) sp ON true
		WHERE h.status='active' AND h.is_archived=false
		ORDER BY a.name, h.position_label`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReadinessCall{}
	for rows.Next() {
		var row ReadinessCall
		var v readinessEvidence
		if err := rows.Scan(&row.HiveID, &row.HiveName, &row.ApiaryID, &row.ApiaryName,
			&v.CrowdedBrood, &v.QueenCups, &v.QueenCells, &v.FramesOfBees,
			&v.FramesOfBrood, &v.FramesOfStores, &v.StoresHoney, &v.FlowOn,
			&v.Temperament, &v.DaysSinceSplit); err != nil {
			return nil, err
		}
		row.DaysSinceLastSplit = v.DaysSinceSplit
		row.Call, row.Evidence = deriveReadiness(v)
		out = append(out, row)
	}
	return out, rows.Err()
}

func checkSwarmReadiness(ctx context.Context, pool *pgxpool.Pool, now time.Time) ([]Result, error) {
	calls, err := SwarmSplitReadiness(ctx, pool, now)
	if err != nil {
		return nil, err
	}
	results := []Result{}
	for _, call := range calls {
		if call.Call == "neither" {
			continue
		}
		id := call.HiveID
		message := fmt.Sprintf(`Hive "%s" is ready to split.`, call.HiveName)
		priority := "high"
		if call.Call == "will_swarm" {
			message = fmt.Sprintf(`Hive "%s" is likely to swarm.`, call.HiveName)
			priority = "urgent"
		}
		results = append(results, Result{HiveID: &id, Message: message, Priority: priority})
	}
	return results, nil
}
