package openwa

import "context"

// SearchService runs full-text message search across sessions. If no search
// provider is configured the server returns 501 (ErrNotImplemented).
// Backed by src/modules/search/search.controller.ts.
type SearchService struct{ client *Client }

// Search searches messages across sessions. Query.Q is required.
func (s *SearchService) Search(ctx context.Context, query SearchQuery) (*SearchResults, error) {
	var out SearchResults
	err := s.client.do(ctx, "GET", "/api/search", query.values(), nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
