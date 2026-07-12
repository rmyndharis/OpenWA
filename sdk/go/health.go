package openwa

import "context"

// HealthService exposes connectivity and readiness probes.
// Backed by src/modules/health/health.controller.ts.
type HealthService struct{ client *Client }

// Check returns the overall health payload.
func (s *HealthService) Check(ctx context.Context) (*HealthResponse, error) {
	var out HealthResponse
	err := s.client.do(ctx, "GET", "/api/health", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Live is the liveness probe.
func (s *HealthService) Live(ctx context.Context) (map[string]string, error) {
	var out map[string]string
	err := s.client.do(ctx, "GET", "/api/health/live", nil, nil, &out)
	return out, err
}

// Ready is the readiness probe.
func (s *HealthService) Ready(ctx context.Context) (*HealthReadyResponse, error) {
	var out HealthReadyResponse
	err := s.client.do(ctx, "GET", "/api/health/ready", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
