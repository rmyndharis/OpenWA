package openwa

import "context"

// CatalogService reads the WhatsApp Business catalog and sends product
// messages. Catalog reads live under /catalog; product sends share the
// messages namespace (/messages/send-product).
// Backed by src/modules/catalog/catalog.controller.ts.
type CatalogService struct{ client *Client }

func (s *CatalogService) sessionBase(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID)
}

// Info returns catalog metadata, or nil when the account has no catalog.
// Baileys only; whatsapp-web.js answers 501.
func (s *CatalogService) Info(ctx context.Context, sessionID string) (*CatalogInfo, error) {
	var out *CatalogInfo
	err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog", nil, nil, &out)
	return out, err
}

// Products returns paginated catalog products. Baileys only; whatsapp-web.js answers 501.
func (s *CatalogService) Products(ctx context.Context, sessionID string, query *CatalogProductsQuery) (*PaginatedProducts, error) {
	var out PaginatedProducts
	err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Product returns a single catalog product, or nil when no product has that id.
// Baileys only; whatsapp-web.js answers 501.
func (s *CatalogService) Product(ctx context.Context, sessionID, productID string) (*CatalogProduct, error) {
	var out *CatalogProduct
	err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products/"+pathEscape(productID), nil, nil, &out)
	return out, err
}

// SendProduct sends a product message. Requires an OPERATOR-level key.
// Baileys only; whatsapp-web.js answers 501.
func (s *CatalogService) SendProduct(ctx context.Context, sessionID string, body SendProductRequest) (*ProductMessageResponse, error) {
	var out ProductMessageResponse
	err := s.client.do(ctx, "POST", s.sessionBase(sessionID)+"/messages/send-product", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
