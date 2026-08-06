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

// ProfilePicturesResponse is a batch profile-picture lookup: a map of contact
// id → picture URL (null when the lookup failed).
type ProfilePicturesResponse struct {
	Pictures map[string]*string `json:"pictures"`
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

// UpsertContactRequest saves or edits an addressbook contact. LastName may be
// empty for a single-name contact.
type UpsertContactRequest struct {
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName,omitempty"`
}
