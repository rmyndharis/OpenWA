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
