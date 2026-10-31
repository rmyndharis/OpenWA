package openwa

import "net/url"

// ContactRecord is a contact.
//
// IsBlocked reflects the account's real blocklist on both engines. When the blocklist query fails
// the field stays at its default rather than reporting "nobody is blocked", and the gateway logs a
// warning — so a false is not proof the contact is unblocked if the session's link is unhealthy.
//
// ProfilePicURL is a cached URL that only Baileys can fill (whatsapp-web.js never sets it) and it is
// often absent there too, so its absence does not say whether the contact has a picture.
type ContactRecord struct {
	ID            string  `json:"id"`
	Name          *string `json:"name,omitempty"`
	Number        *string `json:"number,omitempty"`
	PushName      *string `json:"pushName,omitempty"`
	IsMyContact   bool    `json:"isMyContact"`
	IsBlocked     bool    `json:"isBlocked"`
	ProfilePicURL *string `json:"profilePicUrl,omitempty"`
}

// CheckNumberResponse reports whether a number is on WhatsApp.
type CheckNumberResponse struct {
	Number     string  `json:"number"`
	Exists     bool    `json:"exists"`
	WhatsappID *string `json:"whatsappId"`
}

// ProfilePictureResponse carries a contact's profile picture URL.
type ProfilePictureResponse struct {
	URL *string `json:"url"`
}

// ProfilePicturesResponse is a batch profile-picture lookup: a map of contact
// id → picture URL (null when the lookup failed). An id skipped after a lookup timed out is absent from the map; ask for it again.
type ProfilePicturesResponse struct {
	Pictures map[string]*string `json:"pictures"`
}

// ContactPhoneResponse resolves a contact's phone number.
type ContactPhoneResponse struct {
	ContactID string  `json:"contactId"`
	Phone     *string `json:"phone"`
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
