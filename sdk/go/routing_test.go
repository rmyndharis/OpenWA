package openwa

import (
	"context"
	"testing"
)

// TestRouting exercises every service method and asserts the exact HTTP method
// and path it produces. This is the drift gate: a wrong path (like the
// historical /messages/text vs /messages/send-text) fails here immediately.
func TestRouting(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name       string
		call       func(c *Client)
		wantMethod string
		wantPath   string
	}{
		{"Sessions.List", func(c *Client) { c.Sessions.List(ctx, nil) }, "GET", "/api/sessions"},
		{"Sessions.Get", func(c *Client) { c.Sessions.Get(ctx, "s1") }, "GET", "/api/sessions/s1"},
		{"Sessions.Create", func(c *Client) { c.Sessions.Create(ctx, CreateSessionRequest{}) }, "POST", "/api/sessions"},
		{"Sessions.Delete", func(c *Client) { c.Sessions.Delete(ctx, "s1") }, "DELETE", "/api/sessions/s1"},
		{"Sessions.Start", func(c *Client) { c.Sessions.Start(ctx, "s1") }, "POST", "/api/sessions/s1/start"},
		{"Sessions.Stop", func(c *Client) { c.Sessions.Stop(ctx, "s1") }, "POST", "/api/sessions/s1/stop"},
		{"Sessions.ForceKill", func(c *Client) { c.Sessions.ForceKill(ctx, "s1") }, "POST", "/api/sessions/s1/force-kill"},
		{"Sessions.QRCode", func(c *Client) { c.Sessions.QRCode(ctx, "s1") }, "GET", "/api/sessions/s1/qr"},
		{"Sessions.RequestPairingCode", func(c *Client) { c.Sessions.RequestPairingCode(ctx, "s1", RequestPairingCodeRequest{}) }, "POST", "/api/sessions/s1/pairing-code"},
		{"Sessions.Stats", func(c *Client) { c.Sessions.Stats(ctx) }, "GET", "/api/sessions/stats/overview"},

		{"Messages.List", func(c *Client) { c.Messages.List(ctx, "s1", nil) }, "GET", "/api/sessions/s1/messages"},
		{"Messages.SendText", func(c *Client) { c.Messages.SendText(ctx, "s1", SendTextRequest{}) }, "POST", "/api/sessions/s1/messages/send-text"},
		{"Messages.SendImage", func(c *Client) { c.Messages.SendImage(ctx, "s1", SendMediaRequest{}) }, "POST", "/api/sessions/s1/messages/send-image"},
		{"Messages.SendVideo", func(c *Client) { c.Messages.SendVideo(ctx, "s1", SendMediaRequest{}) }, "POST", "/api/sessions/s1/messages/send-video"},
		{"Messages.SendAudio", func(c *Client) { c.Messages.SendAudio(ctx, "s1", SendAudioRequest{}) }, "POST", "/api/sessions/s1/messages/send-audio"},
		{"Messages.SendDocument", func(c *Client) { c.Messages.SendDocument(ctx, "s1", SendMediaRequest{}) }, "POST", "/api/sessions/s1/messages/send-document"},
		{"Messages.SendSticker", func(c *Client) { c.Messages.SendSticker(ctx, "s1", SendMediaRequest{}) }, "POST", "/api/sessions/s1/messages/send-sticker"},
		{"Messages.SendLocation", func(c *Client) { c.Messages.SendLocation(ctx, "s1", SendLocationRequest{}) }, "POST", "/api/sessions/s1/messages/send-location"},
		{"Messages.SendContact", func(c *Client) { c.Messages.SendContact(ctx, "s1", SendContactRequest{}) }, "POST", "/api/sessions/s1/messages/send-contact"},
		{"Messages.SendTemplate", func(c *Client) { c.Messages.SendTemplate(ctx, "s1", SendTemplateRequest{}) }, "POST", "/api/sessions/s1/messages/send-template"},
		{"Messages.Reply", func(c *Client) { c.Messages.Reply(ctx, "s1", ReplyMessageRequest{}) }, "POST", "/api/sessions/s1/messages/reply"},
		{"Messages.Forward", func(c *Client) { c.Messages.Forward(ctx, "s1", ForwardMessageRequest{}) }, "POST", "/api/sessions/s1/messages/forward"},
		{"Messages.React", func(c *Client) { c.Messages.React(ctx, "s1", ReactMessageRequest{}) }, "POST", "/api/sessions/s1/messages/react"},
		{"Messages.Delete", func(c *Client) { c.Messages.Delete(ctx, "s1", DeleteMessageRequest{}) }, "POST", "/api/sessions/s1/messages/delete"},
		{"Messages.EditMessage", func(c *Client) { c.Messages.EditMessage(ctx, "s1", EditMessageRequest{}) }, "POST", "/api/sessions/s1/messages/edit"},
		{"Messages.History", func(c *Client) { c.Messages.History(ctx, "s1", "c1", nil) }, "GET", "/api/sessions/s1/messages/c1/history"},
		{"Messages.Reactions", func(c *Client) { c.Messages.Reactions(ctx, "s1", "c1", "m1") }, "GET", "/api/sessions/s1/messages/c1/m1/reactions"},
		{"Messages.SendBulk", func(c *Client) { c.Messages.SendBulk(ctx, "s1", SendBulkRequest{}) }, "POST", "/api/sessions/s1/messages/send-bulk"},
		{"Messages.BatchStatus", func(c *Client) { c.Messages.BatchStatus(ctx, "s1", "b1") }, "GET", "/api/sessions/s1/messages/batch/b1"},
		{"Messages.CancelBatch", func(c *Client) { c.Messages.CancelBatch(ctx, "s1", "b1") }, "POST", "/api/sessions/s1/messages/batch/b1/cancel"},

		{"Contacts.List", func(c *Client) { c.Contacts.List(ctx, "s1", nil) }, "GET", "/api/sessions/s1/contacts"},
		{"Contacts.Get", func(c *Client) { c.Contacts.Get(ctx, "s1", "u1") }, "GET", "/api/sessions/s1/contacts/u1"},
		{"Contacts.Check", func(c *Client) { c.Contacts.Check(ctx, "s1", "628") }, "GET", "/api/sessions/s1/contacts/check/628"},
		{"Contacts.ProfilePicture", func(c *Client) { c.Contacts.ProfilePicture(ctx, "s1", "u1") }, "GET", "/api/sessions/s1/contacts/u1/profile-picture"},
		{"Contacts.Phone", func(c *Client) { c.Contacts.Phone(ctx, "s1", "u1") }, "GET", "/api/sessions/s1/contacts/u1/phone"},
		{"Contacts.Block", func(c *Client) { c.Contacts.Block(ctx, "s1", "u1") }, "POST", "/api/sessions/s1/contacts/u1/block"},
		{"Contacts.Unblock", func(c *Client) { c.Contacts.Unblock(ctx, "s1", "u1") }, "DELETE", "/api/sessions/s1/contacts/u1/block"},

		{"Groups.List", func(c *Client) { c.Groups.List(ctx, "s1", nil) }, "GET", "/api/sessions/s1/groups"},
		{"Groups.Get", func(c *Client) { c.Groups.Get(ctx, "s1", "g1") }, "GET", "/api/sessions/s1/groups/g1"},
		{"Groups.Create", func(c *Client) { c.Groups.Create(ctx, "s1", CreateGroupRequest{}) }, "POST", "/api/sessions/s1/groups"},
		{"Groups.JoinGroup", func(c *Client) { c.Groups.JoinGroup(ctx, "s1", JoinGroupRequest{}) }, "POST", "/api/sessions/s1/groups/join"},
		{"Groups.AddParticipants", func(c *Client) { c.Groups.AddParticipants(ctx, "s1", "g1", nil) }, "POST", "/api/sessions/s1/groups/g1/participants"},
		{"Groups.RemoveParticipants", func(c *Client) { c.Groups.RemoveParticipants(ctx, "s1", "g1", nil) }, "DELETE", "/api/sessions/s1/groups/g1/participants"},
		{"Groups.PromoteParticipants", func(c *Client) { c.Groups.PromoteParticipants(ctx, "s1", "g1", nil) }, "POST", "/api/sessions/s1/groups/g1/participants/promote"},
		{"Groups.DemoteParticipants", func(c *Client) { c.Groups.DemoteParticipants(ctx, "s1", "g1", nil) }, "POST", "/api/sessions/s1/groups/g1/participants/demote"},
		{"Groups.SetSubject", func(c *Client) { c.Groups.SetSubject(ctx, "s1", "g1", "x") }, "PUT", "/api/sessions/s1/groups/g1/subject"},
		{"Groups.SetDescription", func(c *Client) { c.Groups.SetDescription(ctx, "s1", "g1", "x") }, "PUT", "/api/sessions/s1/groups/g1/description"},
		{"Groups.Leave", func(c *Client) { c.Groups.Leave(ctx, "s1", "g1") }, "POST", "/api/sessions/s1/groups/g1/leave"},
		{"Groups.InviteCode", func(c *Client) { c.Groups.InviteCode(ctx, "s1", "g1") }, "GET", "/api/sessions/s1/groups/g1/invite-code"},
		{"Groups.RevokeInviteCode", func(c *Client) { c.Groups.RevokeInviteCode(ctx, "s1", "g1") }, "POST", "/api/sessions/s1/groups/g1/invite-code/revoke"},
		{"Groups.GetGroupSettings", func(c *Client) { c.Groups.GetGroupSettings(ctx, "s1", "g1") }, "GET", "/api/sessions/s1/groups/g1/settings"},
		{"Groups.UpdateGroupSettings", func(c *Client) { c.Groups.UpdateGroupSettings(ctx, "s1", "g1", GroupSettings{}) }, "PUT", "/api/sessions/s1/groups/g1/settings"},

		{"Webhooks.List", func(c *Client) { c.Webhooks.List(ctx, "s1") }, "GET", "/api/sessions/s1/webhooks"},
		{"Webhooks.Get", func(c *Client) { c.Webhooks.Get(ctx, "s1", "w1") }, "GET", "/api/sessions/s1/webhooks/w1"},
		{"Webhooks.Create", func(c *Client) { c.Webhooks.Create(ctx, "s1", CreateWebhookRequest{}) }, "POST", "/api/sessions/s1/webhooks"},
		{"Webhooks.Update", func(c *Client) { c.Webhooks.Update(ctx, "s1", "w1", UpdateWebhookRequest{}) }, "PUT", "/api/sessions/s1/webhooks/w1"},
		{"Webhooks.Delete", func(c *Client) { c.Webhooks.Delete(ctx, "s1", "w1") }, "DELETE", "/api/sessions/s1/webhooks/w1"},
		{"Webhooks.Test", func(c *Client) { c.Webhooks.Test(ctx, "s1", "w1") }, "POST", "/api/sessions/s1/webhooks/w1/test"},

		{"Chats.List", func(c *Client) { c.Chats.List(ctx, "s1", nil) }, "GET", "/api/sessions/s1/chats"},
		{"Chats.MarkRead", func(c *Client) { c.Chats.MarkRead(ctx, "s1", MarkChatRequest{}) }, "POST", "/api/sessions/s1/chats/read"},
		{"Chats.MarkUnread", func(c *Client) { c.Chats.MarkUnread(ctx, "s1", MarkChatRequest{}) }, "POST", "/api/sessions/s1/chats/unread"},
		{"Chats.Delete", func(c *Client) { c.Chats.Delete(ctx, "s1", DeleteChatRequest{}) }, "POST", "/api/sessions/s1/chats/delete"},
		{"Chats.SendState", func(c *Client) { c.Chats.SendState(ctx, "s1", SendChatStateRequest{}) }, "POST", "/api/sessions/s1/chats/typing"},

		{"Status.List", func(c *Client) { c.Status.List(ctx, "s1") }, "GET", "/api/sessions/s1/status"},
		{"Status.FromContact", func(c *Client) { c.Status.FromContact(ctx, "s1", "u1") }, "GET", "/api/sessions/s1/status/u1"},
		{"Status.SendText", func(c *Client) { c.Status.SendText(ctx, "s1", SendTextStatusRequest{}) }, "POST", "/api/sessions/s1/status/send-text"},
		{"Status.SendImage", func(c *Client) { c.Status.SendImage(ctx, "s1", SendImageStatusRequest{}) }, "POST", "/api/sessions/s1/status/send-image"},
		{"Status.SendVideo", func(c *Client) { c.Status.SendVideo(ctx, "s1", SendVideoStatusRequest{}) }, "POST", "/api/sessions/s1/status/send-video"},
		{"Status.Delete", func(c *Client) { c.Status.Delete(ctx, "s1", "st1") }, "DELETE", "/api/sessions/s1/status/st1"},

		{"Labels.List", func(c *Client) { c.Labels.List(ctx, "s1") }, "GET", "/api/sessions/s1/labels"},
		{"Labels.Get", func(c *Client) { c.Labels.Get(ctx, "s1", "l1") }, "GET", "/api/sessions/s1/labels/l1"},
		{"Labels.ForChat", func(c *Client) { c.Labels.ForChat(ctx, "s1", "c1") }, "GET", "/api/sessions/s1/labels/chat/c1"},
		{"Labels.AddToChat", func(c *Client) { c.Labels.AddToChat(ctx, "s1", "c1", AddLabelRequest{}) }, "POST", "/api/sessions/s1/labels/chat/c1"},
		{"Labels.RemoveFromChat", func(c *Client) { c.Labels.RemoveFromChat(ctx, "s1", "c1", "l1") }, "DELETE", "/api/sessions/s1/labels/chat/c1/l1"},

		{"Channels.List", func(c *Client) { c.Channels.List(ctx, "s1") }, "GET", "/api/sessions/s1/channels"},
		{"Channels.Get", func(c *Client) { c.Channels.Get(ctx, "s1", "ch1") }, "GET", "/api/sessions/s1/channels/ch1"},
		{"Channels.Messages", func(c *Client) { c.Channels.Messages(ctx, "s1", "ch1", nil) }, "GET", "/api/sessions/s1/channels/ch1/messages"},
		{"Channels.Subscribe", func(c *Client) { c.Channels.Subscribe(ctx, "s1", SubscribeChannelRequest{}) }, "POST", "/api/sessions/s1/channels/subscribe"},
		{"Channels.Unsubscribe", func(c *Client) { c.Channels.Unsubscribe(ctx, "s1", "ch1") }, "DELETE", "/api/sessions/s1/channels/ch1"},

		{"Catalog.Info", func(c *Client) { c.Catalog.Info(ctx, "s1") }, "GET", "/api/sessions/s1/catalog"},
		{"Catalog.Products", func(c *Client) { c.Catalog.Products(ctx, "s1", nil) }, "GET", "/api/sessions/s1/catalog/products"},
		{"Catalog.Product", func(c *Client) { c.Catalog.Product(ctx, "s1", "p1") }, "GET", "/api/sessions/s1/catalog/products/p1"},
		{"Catalog.SendProduct", func(c *Client) { c.Catalog.SendProduct(ctx, "s1", SendProductRequest{}) }, "POST", "/api/sessions/s1/messages/send-product"},
		{"Catalog.SendCatalog", func(c *Client) { c.Catalog.SendCatalog(ctx, "s1", SendCatalogRequest{}) }, "POST", "/api/sessions/s1/messages/send-catalog"},

		{"Templates.List", func(c *Client) { c.Templates.List(ctx, "s1") }, "GET", "/api/sessions/s1/templates"},
		{"Templates.Get", func(c *Client) { c.Templates.Get(ctx, "s1", "t1") }, "GET", "/api/sessions/s1/templates/t1"},
		{"Templates.Create", func(c *Client) { c.Templates.Create(ctx, "s1", CreateTemplateRequest{}) }, "POST", "/api/sessions/s1/templates"},
		{"Templates.Update", func(c *Client) { c.Templates.Update(ctx, "s1", "t1", UpdateTemplateRequest{}) }, "PUT", "/api/sessions/s1/templates/t1"},
		{"Templates.Delete", func(c *Client) { c.Templates.Delete(ctx, "s1", "t1") }, "DELETE", "/api/sessions/s1/templates/t1"},

		{"Health.Check", func(c *Client) { c.Health.Check(ctx) }, "GET", "/api/health"},
		{"Health.Live", func(c *Client) { c.Health.Live(ctx) }, "GET", "/api/health/live"},
		{"Health.Ready", func(c *Client) { c.Health.Ready(ctx) }, "GET", "/api/health/ready"},

		{"Search.Search", func(c *Client) { c.Search.Search(ctx, SearchQuery{Q: "hi"}) }, "GET", "/api/search"},
		{"Auth.Validate", func(c *Client) { c.Auth.Validate(ctx) }, "POST", "/api/auth/validate"},

		{"Profile.SetProfileName", func(c *Client) { c.Profile.SetProfileName(ctx, "s1", SetProfileNameRequest{}) }, "PUT", "/api/sessions/s1/profile/name"},
		{"Profile.SetProfileStatus", func(c *Client) { c.Profile.SetProfileStatus(ctx, "s1", SetProfileStatusRequest{}) }, "PUT", "/api/sessions/s1/profile/status"},
		{"Profile.SetProfilePicture", func(c *Client) { c.Profile.SetProfilePicture(ctx, "s1", SetProfilePictureRequest{}) }, "PUT", "/api/sessions/s1/profile/picture"},

		{"Calls.RejectCall", func(c *Client) { c.Calls.RejectCall(ctx, "s1", "call1") }, "POST", "/api/sessions/s1/calls/call1/reject"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt := &recordTransport{status: 200, body: `{}`}
			c := newTestClient(t, rt)
			tc.call(c)
			if rt.lastReq == nil {
				t.Fatalf("no request issued")
			}
			if rt.lastReq.Method != tc.wantMethod {
				t.Errorf("method = %q, want %q", rt.lastReq.Method, tc.wantMethod)
			}
			if got := rt.lastReq.URL.EscapedPath(); got != tc.wantPath {
				t.Errorf("path = %q, want %q", got, tc.wantPath)
			}
			if h := rt.lastReq.Header.Get("X-API-Key"); h == "" {
				t.Error("missing X-API-Key header")
			}
		})
	}
}
