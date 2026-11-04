package openwa

import "net/url"

// CatalogInfo describes a business catalog. ProductCount counts at most the first 51 products on Baileys.
type CatalogInfo struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Description  *string `json:"description,omitempty"`
	ProductCount int     `json:"productCount"`
	URL          string  `json:"url"`
}

// CatalogProductsQuery paginates the catalog products list.
type CatalogProductsQuery struct {
	Page  *int
	Limit *int
}

func (q *CatalogProductsQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "page", q.Page)
	setInt(v, "limit", q.Limit)
	return v
}

// CatalogProduct is a catalog product.
type CatalogProduct struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	// Price is nil when the product has no price (PriceFormatted is empty then too). A genuine
	// price of 0 is a pointer to 0.
	Price          *float64 `json:"price,omitempty"`
	Currency       string   `json:"currency,omitempty"`
	PriceFormatted string   `json:"priceFormatted,omitempty"`
	ImageURL       *string  `json:"imageUrl,omitempty"`
	URL            string   `json:"url"`
	IsAvailable    bool     `json:"isAvailable"`
	RetailerID     string   `json:"retailerId,omitempty"`
}

// ProductPagination is the pagination block for catalog products.
type ProductPagination struct {
	Page       int `json:"page"`
	Limit      int `json:"limit"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// PaginatedProducts is the paginated catalog products payload.
type PaginatedProducts struct {
	Products   []CatalogProduct  `json:"products"`
	Pagination ProductPagination `json:"pagination"`
}

// SendProductRequest sends a product message.
type SendProductRequest struct {
	ChatID    string `json:"chatId"`
	ProductID string `json:"productId"`
	Body      string `json:"body,omitempty"`
}
