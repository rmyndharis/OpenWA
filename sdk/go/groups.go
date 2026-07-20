package openwa

import "context"

// GroupsService manages WhatsApp groups.
// Backed by src/modules/group/group.controller.ts.
type GroupsService struct{ client *Client }

func (s *GroupsService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/groups"
}

// List returns groups for a session.
func (s *GroupsService) List(ctx context.Context, sessionID string, query *ListGroupsQuery) ([]GroupSummary, error) {
	var out []GroupSummary
	err := s.client.do(ctx, "GET", s.base(sessionID), valuesOf(query), nil, &out)
	return out, err
}

// Get returns full group detail.
func (s *GroupsService) Get(ctx context.Context, sessionID, groupID string) (*GroupInfo, error) {
	var out GroupInfo
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(groupID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Create creates a group.
func (s *GroupsService) Create(ctx context.Context, sessionID string, body CreateGroupRequest) (*GroupInfo, error) {
	var out GroupInfo
	err := s.client.do(ctx, "POST", s.base(sessionID), nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// JoinGroup joins a group via an invite code. Requires an OPERATOR-level key.
func (s *GroupsService) JoinGroup(ctx context.Context, sessionID string, body JoinGroupRequest) (*JoinGroupResponse, error) {
	var out JoinGroupResponse
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/join", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetGroupSettings returns the group's announce / locked / ephemeral-timer
// settings.
func (s *GroupsService) GetGroupSettings(ctx context.Context, sessionID, groupID string) (*GroupSettings, error) {
	var out GroupSettings
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(groupID)+"/settings", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateGroupSettings patches the group settings; at least one field must be
// set (the server rejects an empty patch with a 400). Setting
// EphemeralSeconds returns 501 on the whatsapp-web.js engine. Requires an
// OPERATOR-level key.
func (s *GroupsService) UpdateGroupSettings(ctx context.Context, sessionID, groupID string, body GroupSettings) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(groupID)+"/settings", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// AddParticipants adds members to a group.
func (s *GroupsService) AddParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*SuccessResult, error) {
	return s.participants(ctx, "POST", sessionID, groupID, "/participants", participants)
}

// RemoveParticipants removes members from a group.
func (s *GroupsService) RemoveParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*SuccessResult, error) {
	return s.participants(ctx, "DELETE", sessionID, groupID, "/participants", participants)
}

// PromoteParticipants promotes members to admin.
func (s *GroupsService) PromoteParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*SuccessResult, error) {
	return s.participants(ctx, "POST", sessionID, groupID, "/participants/promote", participants)
}

// DemoteParticipants demotes admins to member.
func (s *GroupsService) DemoteParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*SuccessResult, error) {
	return s.participants(ctx, "POST", sessionID, groupID, "/participants/demote", participants)
}

func (s *GroupsService) participants(ctx context.Context, method, sessionID, groupID, suffix string, participants []string) (*SuccessResult, error) {
	var out SuccessResult
	body := map[string][]string{"participants": participants}
	err := s.client.do(ctx, method, s.base(sessionID)+"/"+pathEscape(groupID)+suffix, nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetSubject updates the group subject (name).
func (s *GroupsService) SetSubject(ctx context.Context, sessionID, groupID, subject string) (*SuccessResult, error) {
	var out SuccessResult
	body := map[string]string{"subject": subject}
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(groupID)+"/subject", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetDescription updates the group description.
func (s *GroupsService) SetDescription(ctx context.Context, sessionID, groupID, description string) (*SuccessResult, error) {
	var out SuccessResult
	body := map[string]string{"description": description}
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(groupID)+"/description", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Leave leaves a group.
func (s *GroupsService) Leave(ctx context.Context, sessionID, groupID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(groupID)+"/leave", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// InviteCode returns the group invite code/link.
func (s *GroupsService) InviteCode(ctx context.Context, sessionID, groupID string) (*InviteCodeResponse, error) {
	var out InviteCodeResponse
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(groupID)+"/invite-code", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeInviteCode rotates the group invite code.
func (s *GroupsService) RevokeInviteCode(ctx context.Context, sessionID, groupID string) (*InviteCodeResponse, error) {
	var out InviteCodeResponse
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(groupID)+"/invite-code/revoke", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
