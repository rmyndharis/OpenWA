package openwa

import "net/url"

// ChannelRecord is a WhatsApp Channel / Newsletter.
type ChannelRecord struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Description     *string `json:"description,omitempty"`
	SubscriberCount int     `json:"subscriberCount,omitempty"`
	PictureURL      *string `json:"pictureUrl,omitempty"`
	Role            string  `json:"role,omitempty"`
}

// ChannelMessageQuery limits the channel message read (default 50).
type ChannelMessageQuery struct {
	Limit *int
}

func (q *ChannelMessageQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	return v
}

// SubscribeChannelRequest subscribes to a channel by invite code.
type SubscribeChannelRequest struct {
	InviteCode string `json:"inviteCode"`
}
