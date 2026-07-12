package openwa

import "net/url"

// SearchQuery is the query for GET /search. Q is required; all else optional.
// DateFrom/DateTo are epoch-ms.
type SearchQuery struct {
	Q         string
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
	MessageID   string  `json:"messageId"`
	WaMessageID string  `json:"waMessageId"`
	SessionID   string  `json:"sessionId"`
	ChatID      string  `json:"chatId"`
	Body        string  `json:"body"`
	Snippet     string  `json:"snippet"`
	Timestamp   int64   `json:"timestamp"`
	Type        string  `json:"type"`
	Direction   string  `json:"direction"`
	From        string  `json:"from"`
	Score       float64 `json:"score,omitempty"`
}

// SearchResults is the GET /search payload.
type SearchResults struct {
	Hits     []SearchHit `json:"hits"`
	Total    int         `json:"total"`
	TookMs   int         `json:"tookMs"`
	Provider string      `json:"provider"`
}
