package openwa

import "net/url"

// GroupParticipant is a group member.
type GroupParticipant struct {
	ID           string `json:"id"`
	Number       string `json:"number,omitempty"`
	Name         string `json:"name,omitempty"`
	IsAdmin      bool   `json:"isAdmin,omitempty"`
	IsSuperAdmin bool   `json:"isSuperAdmin,omitempty"`
}

// GroupSummary is the slim group shape from the list endpoint. Note that
// ParticipantsCount and IsAdmin are stripped by the LIST endpoint on the
// current engine and will normally be absent from the payload — use Groups.Get
// (which returns GroupInfo) when you need them. They are pointers so a missing
// field decodes as nil rather than being confused with a zero-valued present
// field.
type GroupSummary struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	ParticipantsCount *int    `json:"participantsCount,omitempty"`
	IsAdmin           *bool   `json:"isAdmin,omitempty"`
	LinkedParentJID   *string `json:"linkedParentJID,omitempty"`
}

// GroupMembershipRequest is a pending request to join a group. Only ParticipantID is always
// present; the engine reports the rest when it has it.
type GroupMembershipRequest struct {
	ParticipantID string `json:"participantId"`
	AddedByID     string `json:"addedById,omitempty"`
	// Method is one of: invite_link, non_admin_add, linked_group_join.
	Method string `json:"method,omitempty"`
	// RequestedAt is Unix seconds.
	RequestedAt float64 `json:"requestedAt,omitempty"`
}

// MembershipRequestActionRequest names the requesters to approve or reject. Acting on every pending
// request is expressed by sending no body field at all, which membershipRequestAction does with an
// empty body — not by this struct.
//
// No `omitempty`: it drops an empty slice as readily as a nil one, so "approve nobody" would reach
// the gateway as the bodyless "approve everybody". The other four clients key on null rather than
// emptiness and send `{"participants": []}` for an empty list, which the gateway rejects with 400;
// the tag made Go the only client where that input silently admitted every pending requester.
type MembershipRequestActionRequest struct {
	Participants []string `json:"participants"`
}

// GroupInfo is the full group detail.
type GroupInfo struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Description     *string            `json:"description,omitempty"`
	Owner           *string            `json:"owner,omitempty"`
	CreatedAt       int64              `json:"createdAt,omitempty"`
	Participants    []GroupParticipant `json:"participants,omitempty"`
	IsReadOnly      bool               `json:"isReadOnly,omitempty"`
	IsAnnounce      bool               `json:"isAnnounce,omitempty"`
	LinkedParentJID *string            `json:"linkedParentJID,omitempty"`
}

// CreateGroupRequest creates a group with initial participants.
type CreateGroupRequest struct {
	Name         string   `json:"name"`
	Participants []string `json:"participants"`
}

// InviteCodeResponse carries a group invite code/link.
type InviteCodeResponse struct {
	InviteCode string `json:"inviteCode,omitempty"`
	InviteLink string `json:"inviteLink,omitempty"`
	Message    string `json:"message,omitempty"`
}

// JoinGroupRequest joins a group via an invite code (the token from a
// https://chat.whatsapp.com/<code> link).
type JoinGroupRequest struct {
	InviteCode string `json:"inviteCode"`
}

// JoinGroupResponse is the join acknowledgement.
type JoinGroupResponse struct {
	Success bool   `json:"success"`
	GroupID string `json:"groupId"`
}

// GroupSettings is the announce / locked / ephemeral-timer state of a group —
// the response of GetGroupSettings and the patch body of UpdateGroupSettings.
// Every field is a pointer: the engine may omit any of them on reads, and on
// updates unset fields are omitted from the body so only the provided settings
// are touched. At least one field must be set for an update — the server
// rejects an empty patch with a 400. EphemeralSeconds is the
// disappearing-messages timer in seconds (0 disables; known values 86400,
// 604800, 7776000) and is unsupported on the whatsapp-web.js engine (501).
type GroupSettings struct {
	Announce         *bool `json:"announce,omitempty"`
	Locked           *bool `json:"locked,omitempty"`
	EphemeralSeconds *int  `json:"ephemeralSeconds,omitempty"`
	// MemberAddMode is "all" (any member may add participants) or "admins".
	MemberAddMode *string `json:"memberAddMode,omitempty"`
}

// ListGroupsQuery paginates the group list.
type ListGroupsQuery struct {
	Limit  *int
	Offset *int
}

func (q *ListGroupsQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}

// SetGroupPictureRequest sets a group's picture. Provide URL or Base64 (Base64
// wins when both are set); Mimetype is required with Base64.
type SetGroupPictureRequest struct {
	URL      string `json:"url,omitempty"`
	Base64   string `json:"base64,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
}

// GroupPictureResponse carries the group's picture URL, empty when it has none.
type GroupPictureResponse struct {
	URL string `json:"url"`
}
