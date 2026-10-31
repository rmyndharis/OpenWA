package openwa

import "net/url"

// SearchQuery is the query for GET /search. Q is required; all else optional.
// DateFrom/DateTo are epoch-ms. Q holds at most 1000 characters and 32 words (the server answers 400
// above either). Limit defaults to 50 and is capped at the server's SEARCH_LIMIT_MAX (100 by default);
// Offset is at most 100000 (400 above). Match is "word" (the server default: whole words) or "contains"
// (any part of a word, ignoring case and accents; needs a term of 3+ characters, and a server with
// SEARCH_CONTAINS_ENABLED=true, else 501).
type SearchQuery struct {
	Q         string
	Match     *string
	SessionID *string
	ChatID    *string
	Direction *string
	Type      *string
	From      *string
	DateFrom  *int64
	DateTo    *int64
	Limit     *int
	Offset    *int
}

func (q *SearchQuery) values() url.Values {
	v := url.Values{}
	v.Set("q", q.Q)
	setStr(v, "match", q.Match)
	setStr(v, "sessionId", q.SessionID)
	setStr(v, "chatId", q.ChatID)
	setStr(v, "direction", q.Direction)
	setStr(v, "type", q.Type)
	setStr(v, "from", q.From)
	setInt64(v, "dateFrom", q.DateFrom)
	setInt64(v, "dateTo", q.DateTo)
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}

// SearchHit is one search result.
type SearchHit struct {
	MessageID   string           `json:"messageId"`
	WaMessageID string           `json:"waMessageId"`
	SessionID   string           `json:"sessionId"`
	ChatID      string           `json:"chatId"`
	Body        string           `json:"body"`
	Snippet     string           `json:"snippet"`
	Timestamp   int64            `json:"timestamp"`
	Type        string           `json:"type"`
	Direction   MessageDirection `json:"direction"`
	From        string           `json:"from"`
	Score       float64          `json:"score,omitempty"`
}

// SearchResults is the GET /search payload.
type SearchResults struct {
	Hits     []SearchHit `json:"hits"`
	Total    int         `json:"total"`
	TookMs   int         `json:"tookMs"`
	Provider string      `json:"provider"`
}
