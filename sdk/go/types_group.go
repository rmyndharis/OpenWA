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
