package openwa

import "context"

// WebhooksService configures event delivery to external HTTP endpoints.
// Backed by src/modules/webhook/webhook.controller.ts.
type WebhooksService struct{ client *Client }

func (s *WebhooksService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/webhooks"
}

// ListAll returns webhooks across EVERY session the key can see, not one session's. Requires an
// OPERATOR-level key.
func (s *WebhooksService) ListAll(ctx context.Context, query *DeliveryFailureQuery) ([]WebhookResponse, error) {
	var out []WebhookResponse
	err := s.client.do(ctx, "GET", "/api/webhooks", query.values(), nil, &out)
	return out, err
}

// DeliveryFailures returns deliveries that were ATTEMPTED and failed — the diagnostic for a webhook
// that stopped arriving. Requires an ADMIN-level key.
//
// A delivery a smart filter suppressed never reaches this log. The response has no published schema,
// so it decodes into a generic value.
func (s *WebhooksService) DeliveryFailures(ctx context.Context, query *DeliveryFailureQuery) (any, error) {
	var out any
	err := s.client.do(ctx, "GET", "/api/webhooks/delivery-failures", query.values(), nil, &out)
	return out, err
}

// List returns webhooks for a session.
func (s *WebhooksService) List(ctx context.Context, sessionID string) ([]WebhookResponse, error) {
	var out []WebhookResponse
	err := s.client.do(ctx, "GET", s.base(sessionID), nil, nil, &out)
	return out, err
}

// Get returns a single webhook.
func (s *WebhooksService) Get(ctx context.Context, sessionID, webhookID string) (*WebhookResponse, error) {
	var out WebhookResponse
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(webhookID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Create registers a webhook.
func (s *WebhooksService) Create(ctx context.Context, sessionID string, body CreateWebhookRequest) (*WebhookResponse, error) {
	var out WebhookResponse
	err := s.client.do(ctx, "POST", s.base(sessionID), nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Update modifies a webhook.
func (s *WebhooksService) Update(ctx context.Context, sessionID, webhookID string, body UpdateWebhookRequest) (*WebhookResponse, error) {
	var out WebhookResponse
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(webhookID), nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a webhook.
func (s *WebhooksService) Delete(ctx context.Context, sessionID, webhookID string) error {
	return s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(webhookID), nil, nil, nil)
}

// Test triggers a test delivery.
func (s *WebhooksService) Test(ctx context.Context, sessionID, webhookID string) (*WebhookTestResult, error) {
	var out WebhookTestResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(webhookID)+"/test", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
