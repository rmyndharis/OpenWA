package openwa

import (
	"encoding/json"
	"testing"
)

// The chat-history route returns the engine payload verbatim, so the only thing standing between a
// caller and a silently-empty field is this struct's tags. Nothing else exercises them: the routing
// test asserts the URL and never decodes a body.
func TestChatHistoryMessageDecodesEngineFields(t *testing.T) {
	raw := []byte(`{
	  "id":"true_628@c.us_ABC","from":"628@c.us","to":"629@c.us","chatId":"628@c.us",
	  "body":"","type":"call","timestamp":1719312000,"fromMe":false,"isGroup":false,
	  "kind":"individual","ephemeralDuration":604800,"isForwarded":true,"forwardingScore":2,
	  "call":{"video":true,"missed":false},
	  "contact":{"pushName":"Budi","number":"628","isMyContact":true,"verifiedLevel":0,"labels":["vip"]}
	}`)

	var m ChatHistoryMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.EphemeralDuration != 604800 {
		t.Errorf("ephemeralDuration = %d, want 604800", m.EphemeralDuration)
	}
	if !m.IsForwarded || m.ForwardingScore != 2 {
		t.Errorf("forwarded = %v score = %d, want true and 2", m.IsForwarded, m.ForwardingScore)
	}
	if m.Call == nil || !m.Call.Video || m.Call.Missed {
		t.Errorf("call = %+v, want {Video:true Missed:false}", m.Call)
	}
	if m.Contact == nil || m.Contact.PushName != "Budi" || m.Contact.Number != "628" || !m.Contact.IsMyContact {
		t.Errorf("contact = %+v", m.Contact)
	}
	if len(m.Contact.Labels) != 1 || m.Contact.Labels[0] != "vip" {
		t.Errorf("contact.labels = %v, want [vip]", m.Contact.Labels)
	}
	// The pointer is the point: verifiedLevel 0 is "unverified", not "the server said nothing".
	if m.Contact.VerifiedLevel == nil || *m.Contact.VerifiedLevel != 0 {
		t.Errorf("contact.verifiedLevel = %v, want a pointer to 0", m.Contact.VerifiedLevel)
	}
}

func TestChatHistoryMessageLeavesAbsentFieldsEmpty(t *testing.T) {
	raw := []byte(`{"id":"x","from":"a","to":"b","chatId":"c","body":"","type":"text",
	  "timestamp":1,"fromMe":false,"isGroup":false,"kind":"individual"}`)

	var m ChatHistoryMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.Call != nil || m.Contact != nil || m.Font != nil {
		t.Errorf("absent optionals should stay nil: call=%v contact=%v font=%v", m.Call, m.Contact, m.Font)
	}
	if m.EphemeralDuration != 0 || m.BackgroundColor != "" {
		t.Errorf("absent scalars should stay zero: ephemeral=%d bg=%q", m.EphemeralDuration, m.BackgroundColor)
	}
	if m.IsForwarded || m.ForwardingScore != 0 {
		t.Errorf("absent forwarded marker should stay zero: forwarded=%v score=%d", m.IsForwarded, m.ForwardingScore)
	}
}

func TestChatSummaryDecodesOptionalLastMessageType(t *testing.T) {
	var chats []ChatSummary
	if err := json.Unmarshal([]byte(`[{"id":"photo@c.us","lastMessageType":"image"},{"id":"empty@c.us"}]`), &chats); err != nil {
		t.Fatal(err)
	}
	if chats[0].LastMessageType != MsgImage || chats[1].LastMessageType != "" {
		t.Fatalf("unexpected types: %+v", chats)
	}
	wire, err := json.Marshal(chats[1])
	if err != nil {
		t.Fatal(err)
	}
	var empty map[string]interface{}
	if err := json.Unmarshal(wire, &empty); err != nil {
		t.Fatal(err)
	}
	if _, ok := empty["lastMessageType"]; ok {
		t.Fatal("absent type must stay omitted")
	}
}

func TestChatHistoryDecodesPollChoices(t *testing.T) {
	var m ChatHistoryMessage
	if err := json.Unmarshal([]byte(`{"poll":{"name":"Q","options":[" Park ","Beach"],"allowMultipleAnswers":true}}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.Poll == nil || m.Poll.Name != "Q" || m.Poll.Options[0] != " Park " || !m.Poll.AllowMultipleAnswers {
		t.Fatalf("poll = %+v", m.Poll)
	}
}
