package openwa

import "context"

// ContactsService looks up and manages contacts.
// Backed by src/modules/contact/contact.controller.ts.
type ContactsService struct{ client *Client }

func (s *ContactsService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/contacts"
}

// List returns contacts for a session.
func (s *ContactsService) List(ctx context.Context, sessionID string, query *ListContactsQuery) ([]ContactRecord, error) {
	var out []ContactRecord
	err := s.client.do(ctx, "GET", s.base(sessionID), valuesOf(query), nil, &out)
	return out, err
}

// Get returns a single contact.
func (s *ContactsService) Get(ctx context.Context, sessionID, contactID string) (*ContactRecord, error) {
	var out ContactRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(contactID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Check reports whether a number is on WhatsApp.
func (s *ContactsService) Check(ctx context.Context, sessionID, number string) (*CheckNumberResponse, error) {
	var out CheckNumberResponse
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/check/"+pathEscape(number), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ProfilePicture returns a contact's profile picture URL.
func (s *ContactsService) ProfilePicture(ctx context.Context, sessionID, contactID string) (*ProfilePictureResponse, error) {
	var out ProfilePictureResponse
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(contactID)+"/profile-picture", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Phone resolves a contact's phone number.
func (s *ContactsService) Phone(ctx context.Context, sessionID, contactID string) (*ContactPhoneResponse, error) {
	var out ContactPhoneResponse
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(contactID)+"/phone", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Block blocks a contact.
func (s *ContactsService) Block(ctx context.Context, sessionID, contactID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(contactID)+"/block", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Unblock unblocks a contact.
func (s *ContactsService) Unblock(ctx context.Context, sessionID, contactID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(contactID)+"/block", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
