package openwa

import "context"

// CatalogService reads the WhatsApp Business catalog and sends product/catalog
// messages. Catalog reads live under /catalog; product/catalog SENDS share the
// messages namespace (/messages/send-product, /messages/send-catalog).
// Backed by src/modules/catalog/catalog.controller.ts.
type CatalogService struct{ client *Client }

func (s *CatalogService) sessionBase(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID)
}

// Info returns catalog metadata.
func (s *CatalogService) Info(ctx context.Context, sessionID string) (*CatalogInfo, error) {
	var out CatalogInfo
	err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Products returns paginated catalog products.
func (s *CatalogService) Products(ctx context.Context, sessionID string, query *CatalogProductsQuery) (*PaginatedProducts, error) {
	var out PaginatedProducts
	err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products", valuesOf(query), nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Product returns a single catalog product.
func (s *CatalogService) Product(ctx context.Context, sessionID, productID string) (*CatalogProduct, error) {
	var out CatalogProduct
	err := s.client.do(ctx, "GET", s.sessionBase(sessionID)+"/catalog/products/"+pathEscape(productID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SendProduct sends a product message. Requires an OPERATOR-level key.
func (s *CatalogService) SendProduct(ctx context.Context, sessionID string, body SendProductRequest) (*MessageResponse, error) {
	var out MessageResponse
	err := s.client.do(ctx, "POST", s.sessionBase(sessionID)+"/messages/send-product", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SendCatalog sends a catalog link message. Requires an OPERATOR-level key.
func (s *CatalogService) SendCatalog(ctx context.Context, sessionID string, body SendCatalogRequest) (*MessageResponse, error) {
	var out MessageResponse
	err := s.client.do(ctx, "POST", s.sessionBase(sessionID)+"/messages/send-catalog", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
