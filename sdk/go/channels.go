package openwa

import "context"

// ChannelsService manages WhatsApp Channels / Newsletters.
// Backed by src/modules/channel/channel.controller.ts.
type ChannelsService struct{ client *Client }

func (s *ChannelsService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/channels"
}

// List returns channels for a session.
func (s *ChannelsService) List(ctx context.Context, sessionID string) ([]ChannelRecord, error) {
	var out []ChannelRecord
	err := s.client.do(ctx, "GET", s.base(sessionID), nil, nil, &out)
	return out, err
}

// Get returns a single channel.
func (s *ChannelsService) Get(ctx context.Context, sessionID, channelID string) (*ChannelRecord, error) {
	var out ChannelRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(channelID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Messages returns recent messages from a channel.
func (s *ChannelsService) Messages(ctx context.Context, sessionID, channelID string, query *ChannelMessageQuery) ([]ChannelMessageRecord, error) {
	var out []ChannelMessageRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(channelID)+"/messages", valuesOf(query), nil, &out)
	return out, err
}

// Create makes a channel. The account owns it, which is what makes Delete possible later.
func (s *ChannelsService) Create(ctx context.Context, sessionID string, body CreateChannelRequest) (*ChannelRecord, error) {
	var out ChannelRecord
	err := s.client.do(ctx, "POST", s.base(sessionID), nil, body, &out)
	return &out, err
}

// Delete destroys a channel this account owns. Irreversible, and every subscriber loses it.
//
// Note the path: Unsubscribe is the DELETE route, and the two are deliberately not reachable by the
// same request — leaving a channel and destroying it are very different acts.
func (s *ChannelsService) Delete(ctx context.Context, sessionID, channelID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(channelID)+"/delete", nil, nil, &out)
	return &out, err
}

// Mute mutes or unmutes a channel's notifications. The subscription is untouched either way.
func (s *ChannelsService) Mute(ctx context.Context, sessionID, channelID string, body MuteChannelRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(channelID)+"/mute", nil, body, &out)
	return &out, err
}

// Subscribe subscribes to a channel by invite code. Requires an OPERATOR-level key.
func (s *ChannelsService) Subscribe(ctx context.Context, sessionID string, body SubscribeChannelRequest) (*ChannelRecord, error) {
	var out ChannelRecord
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/subscribe", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Unsubscribe unsubscribes from a channel. Requires an OPERATOR-level key.
func (s *ChannelsService) Unsubscribe(ctx context.Context, sessionID, channelID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(channelID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
