package openwa

import "context"

// AuthService validates the configured API key.
// Backed by src/modules/auth/auth-validate.controller.ts.
type AuthService struct{ client *Client }

// Validate confirms the API key is valid and returns its role.
func (s *AuthService) Validate(ctx context.Context) (*AuthValidateResponse, error) {
	var out AuthValidateResponse
	err := s.client.do(ctx, "POST", "/api/auth/validate", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
