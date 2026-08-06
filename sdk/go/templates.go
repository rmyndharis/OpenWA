package openwa

import "context"

// TemplatesService manages stored message templates with {{variable}}
// placeholders. Backed by src/modules/template/template.controller.ts.
type TemplatesService struct{ client *Client }

func (s *TemplatesService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/templates"
}

// List returns templates for a session.
func (s *TemplatesService) List(ctx context.Context, sessionID string) ([]TemplateRecord, error) {
	var out []TemplateRecord
	err := s.client.do(ctx, "GET", s.base(sessionID), nil, nil, &out)
	return out, err
}

// Get returns a single template.
func (s *TemplatesService) Get(ctx context.Context, sessionID, templateID string) (*TemplateRecord, error) {
	var out TemplateRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(templateID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Create creates a template.
func (s *TemplatesService) Create(ctx context.Context, sessionID string, body CreateTemplateRequest) (*TemplateRecord, error) {
	var out TemplateRecord
	err := s.client.do(ctx, "POST", s.base(sessionID), nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Update modifies a template.
func (s *TemplatesService) Update(ctx context.Context, sessionID, templateID string, body UpdateTemplateRequest) (*TemplateRecord, error) {
	var out TemplateRecord
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(templateID), nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a template.
func (s *TemplatesService) Delete(ctx context.Context, sessionID, templateID string) error {
	return s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(templateID), nil, nil, nil)
}
