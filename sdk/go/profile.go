package openwa

import "context"

// ProfileService manages the connected account's own profile.
// Backed by src/modules/profile/profile.controller.ts. All methods require an
// OPERATOR-level key.
type ProfileService struct{ client *Client }

func (s *ProfileService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/profile"
}

// SetProfileName sets the account display name.
func (s *ProfileService) SetProfileName(ctx context.Context, sessionID string, body SetProfileNameRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/name", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetProfileStatus sets the account about/status text; an empty Status clears
// it.
func (s *ProfileService) SetProfileStatus(ctx context.Context, sessionID string, body SetProfileStatusRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/status", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetProfilePicture sets the account profile picture from a public URL or
// inline base64 (provide exactly one).
func (s *ProfileService) SetProfilePicture(ctx context.Context, sessionID string, body SetProfilePictureRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/picture", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
