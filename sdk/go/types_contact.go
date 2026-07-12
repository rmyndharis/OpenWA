package openwa

import "net/url"

// ContactRecord is a contact.
type ContactRecord struct {
	ID          string  `json:"id"`
	Name        *string `json:"name,omitempty"`
	Number      *string `json:"number,omitempty"`
	Pushname    *string `json:"pushname,omitempty"`
	IsBusiness  bool    `json:"isBusiness,omitempty"`
	IsMyContact bool    `json:"isMyContact,omitempty"`
}

// CheckNumberResponse reports whether a number is on WhatsApp.
type CheckNumberResponse struct {
	Number     string  `json:"number"`
	Exists     bool    `json:"exists"`
	WhatsappID *string `json:"whatsappId,omitempty"`
}

// ProfilePictureResponse carries a contact's profile picture URL.
type ProfilePictureResponse struct {
	URL *string `json:"url,omitempty"`
}

// ContactPhoneResponse resolves a contact's phone number.
type ContactPhoneResponse struct {
	ContactID string  `json:"contactId"`
	Phone     *string `json:"phone,omitempty"`
}

// ListContactsQuery paginates the contact list.
type ListContactsQuery struct {
	Limit  *int
	Offset *int
}

func (q *ListContactsQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}
