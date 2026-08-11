package openwa

import (
	"context"
	"net/url"
)

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

// JoinInfo previews a group from its invite code WITHOUT joining. Read-only, so it is safe to call
// on a code from an untrusted source.
//
// There is no participant list — the account is not a member — only a count, and only when WhatsApp
// discloses one. Fields the engine did not report are nil rather than zeroed.
func (s *GroupsService) JoinInfo(ctx context.Context, sessionID, code string) (*GroupJoinInfo, error) {
	var out GroupJoinInfo
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/join-info", url.Values{"code": {code}}, nil, &out)
	return &out, err
}

// Create creates a group.
// Create makes a new group. It answers the group SUMMARY, not the detail shape Get returns — there is
// no participant list, description, owner or creation time on a create response.
func (s *GroupsService) Create(ctx context.Context, sessionID string, body CreateGroupRequest) (*GroupSummary, error) {
	var out GroupSummary
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
func (s *GroupsService) AddParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*ParticipantsResult, error) {
	return s.participants(ctx, "POST", sessionID, groupID, "/participants", participants)
}

// RemoveParticipants removes members from a group.
func (s *GroupsService) RemoveParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*ParticipantsResult, error) {
	return s.participants(ctx, "DELETE", sessionID, groupID, "/participants", participants)
}

// PromoteParticipants promotes members to admin.
func (s *GroupsService) PromoteParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*ParticipantsResult, error) {
	return s.participants(ctx, "POST", sessionID, groupID, "/participants/promote", participants)
}

// DemoteParticipants demotes admins to member.
func (s *GroupsService) DemoteParticipants(ctx context.Context, sessionID, groupID string, participants []string) (*ParticipantsResult, error) {
	return s.participants(ctx, "POST", sessionID, groupID, "/participants/demote", participants)
}

func (s *GroupsService) participants(ctx context.Context, method, sessionID, groupID, suffix string, participants []string) (*ParticipantsResult, error) {
	var out ParticipantsResult
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

// GetPicture returns the group's picture URL, empty when it has none.
func (s *GroupsService) GetPicture(ctx context.Context, sessionID, groupID string) (*GroupPictureResponse, error) {
	var out GroupPictureResponse
	if err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(groupID)+"/picture", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetPicture sets the group's picture. Requires admin rights on the group.
func (s *GroupsService) SetPicture(ctx context.Context, sessionID, groupID string, body SetGroupPictureRequest) (*SuccessResult, error) {
	var out SuccessResult
	if err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(groupID)+"/picture", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeletePicture removes the group's picture. Requires admin rights on the group.
func (s *GroupsService) DeletePicture(ctx context.Context, sessionID, groupID string) (*SuccessResult, error) {
	var out SuccessResult
	if err := s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(groupID)+"/picture", nil, nil, &out); err != nil {
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

// GetMembershipRequests lists a group's pending join requests. Requires the account to be a group
// admin. Only ParticipantID is guaranteed on each entry — the engine reports the rest when it has it.
func (s *GroupsService) GetMembershipRequests(
	ctx context.Context, sessionID, groupID string,
) ([]GroupMembershipRequest, error) {
	var out []GroupMembershipRequest
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(groupID)+"/membership-requests", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ApproveMembershipRequests approves pending join requests. Pass a nil slice to approve every
// pending request.
//
// A partial refusal answers 200 and reports it per participant in Results, so Success alone does
// not mean everyone was let in.
func (s *GroupsService) ApproveMembershipRequests(
	ctx context.Context, sessionID, groupID string, participants []string,
) (*ParticipantsResult, error) {
	return s.membershipRequestAction(ctx, sessionID, groupID, "approve", participants)
}

// RejectMembershipRequests rejects pending join requests. Pass a nil slice to reject every pending
// request.
func (s *GroupsService) RejectMembershipRequests(
	ctx context.Context, sessionID, groupID string, participants []string,
) (*ParticipantsResult, error) {
	return s.membershipRequestAction(ctx, sessionID, groupID, "reject", participants)
}

func (s *GroupsService) membershipRequestAction(
	ctx context.Context, sessionID, groupID, verb string, participants []string,
) (*ParticipantsResult, error) {
	// A nil slice means "every pending request", which the gateway reads from the ABSENCE of the
	// key — `null` is not absence there, so the bodyless case sends an empty object rather than the
	// struct. A non-nil slice always sends the key, empty included, so naming nobody stays a 400
	// instead of collapsing into naming everybody.
	var body any = struct{}{}
	if participants != nil {
		body = MembershipRequestActionRequest{Participants: participants}
	}
	var out ParticipantsResult
	err := s.client.do(
		ctx, "POST", s.base(sessionID)+"/"+pathEscape(groupID)+"/membership-requests/"+verb, nil, body, &out,
	)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
