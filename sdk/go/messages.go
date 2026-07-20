package openwa

import "context"

// MessagesService sends and queries messages.
// Backed by src/modules/message/message.controller.ts. NOTE: send paths use the
// "send-" prefix (e.g. /messages/send-text).
type MessagesService struct{ client *Client }

func (s *MessagesService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/messages"
}

// List returns persisted messages for a session.
func (s *MessagesService) List(ctx context.Context, sessionID string, query *ListMessagesQuery) (*MessageListResponse, error) {
	var out MessageListResponse
	err := s.client.do(ctx, "GET", s.base(sessionID), valuesOf(query), nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SendText sends a plain text message.
func (s *MessagesService) SendText(ctx context.Context, sessionID string, body SendTextRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-text", body)
}

// SendImage sends an image.
func (s *MessagesService) SendImage(ctx context.Context, sessionID string, body SendMediaRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-image", body)
}

// SendVideo sends a video.
func (s *MessagesService) SendVideo(ctx context.Context, sessionID string, body SendMediaRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-video", body)
}

// SendAudio sends audio (set PTT for a voice note).
func (s *MessagesService) SendAudio(ctx context.Context, sessionID string, body SendAudioRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-audio", body)
}

// SendDocument sends a document.
func (s *MessagesService) SendDocument(ctx context.Context, sessionID string, body SendMediaRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-document", body)
}

// SendSticker sends a sticker.
func (s *MessagesService) SendSticker(ctx context.Context, sessionID string, body SendMediaRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-sticker", body)
}

// SendLocation sends a location pin.
func (s *MessagesService) SendLocation(ctx context.Context, sessionID string, body SendLocationRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-location", body)
}

// SendContact sends a contact card.
func (s *MessagesService) SendContact(ctx context.Context, sessionID string, body SendContactRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-contact", body)
}

// SendTemplate sends a stored template.
func (s *MessagesService) SendTemplate(ctx context.Context, sessionID string, body SendTemplateRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "send-template", body)
}

func (s *MessagesService) send(ctx context.Context, sessionID, segment string, body any) (*MessageResponse, error) {
	var out MessageResponse
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+segment, nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Reply replies to a quoted message.
func (s *MessagesService) Reply(ctx context.Context, sessionID string, body ReplyMessageRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "reply", body)
}

// Forward forwards a message between chats.
func (s *MessagesService) Forward(ctx context.Context, sessionID string, body ForwardMessageRequest) (*MessageResponse, error) {
	return s.send(ctx, sessionID, "forward", body)
}

// React adds (or, with an empty emoji, removes) a reaction.
func (s *MessagesService) React(ctx context.Context, sessionID string, body ReactMessageRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/react", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete deletes a message.
func (s *MessagesService) Delete(ctx context.Context, sessionID string, body DeleteMessageRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/delete", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// EditMessage edits the text of a message sent by this account. Requires an
// OPERATOR-level key. The server responds 404 when the message is not found.
func (s *MessagesService) EditMessage(ctx context.Context, sessionID string, body EditMessageRequest) (*MessageResponse, error) {
	var out MessageResponse
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/edit", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// History reads live chat history from WhatsApp.
func (s *MessagesService) History(ctx context.Context, sessionID, chatID string, query *MessageHistoryQuery) ([]ChatHistoryMessage, error) {
	var out []ChatHistoryMessage
	path := s.base(sessionID) + "/" + pathEscape(chatID) + "/history"
	err := s.client.do(ctx, "GET", path, valuesOf(query), nil, &out)
	return out, err
}

// Reactions returns the reactions on a message.
func (s *MessagesService) Reactions(ctx context.Context, sessionID, chatID, messageID string) ([]ReactionRecord, error) {
	var out []ReactionRecord
	path := s.base(sessionID) + "/" + pathEscape(chatID) + "/" + pathEscape(messageID) + "/reactions"
	err := s.client.do(ctx, "GET", path, nil, nil, &out)
	return out, err
}

// SendBulk queues a batch of messages.
func (s *MessagesService) SendBulk(ctx context.Context, sessionID string, body SendBulkRequest) (*BulkMessageResponse, error) {
	var out BulkMessageResponse
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/send-bulk", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// BatchStatus returns the status of a bulk batch.
func (s *MessagesService) BatchStatus(ctx context.Context, sessionID, batchID string) (*BatchStatusResponse, error) {
	var out BatchStatusResponse
	path := s.base(sessionID) + "/batch/" + pathEscape(batchID)
	err := s.client.do(ctx, "GET", path, nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CancelBatch cancels a running batch. Requires an OPERATOR-level key.
func (s *MessagesService) CancelBatch(ctx context.Context, sessionID, batchID string) (*BatchStatusResponse, error) {
	var out BatchStatusResponse
	path := s.base(sessionID) + "/batch/" + pathEscape(batchID) + "/cancel"
	err := s.client.do(ctx, "POST", path, nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
