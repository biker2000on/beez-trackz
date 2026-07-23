package jobs

import (
	"fmt"

	"github.com/hibiken/asynq"
)

// Task type names shared between the API (enqueuer) and the worker.
const (
	TypeProcessImage       = "media:process_image"
	TypeTranscribeAudio    = "ai:transcribe_audio"
	TypeGenerateRecs       = "recs:generate"
)

type ProcessImagePayload struct {
	PhotoID string `json:"photoId"`
}

type TranscribeAudioPayload struct {
	RecordingID string `json:"recordingId"`
}

type GenerateRecsPayload struct {
	// Empty for now — the job scans all hives; scoping fields can be added later.
}

func redisOpt(redisURL string) (asynq.RedisConnOpt, error) {
	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	return opt, nil
}

// NewClient creates the enqueue-side asynq client used by the API server.
func NewClient(redisURL string) (*asynq.Client, error) {
	opt, err := redisOpt(redisURL)
	if err != nil {
		return nil, err
	}
	return asynq.NewClient(opt), nil
}
