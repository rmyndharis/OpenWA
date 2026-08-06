package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CheckNumberResponse;
import com.rmyndharis.openwa.model.ContactPhoneResponse;
import com.rmyndharis.openwa.model.ContactRecord;
import com.rmyndharis.openwa.model.ListContactsQuery;
import com.rmyndharis.openwa.model.ProfilePictureResponse;
import com.rmyndharis.openwa.model.ProfilePicturesResponse;
import com.rmyndharis.openwa.model.SuccessResult;
import com.rmyndharis.openwa.model.UpsertContactRequest;
import java.util.List;
import java.util.Map;

/** Contacts resource — contact lookup and management. */
public final class ContactsResource {
    private final OpenWAClient client;

    public ContactsResource(OpenWAClient client) {
        this.client = client;
    }

    /** List contacts known to the session. */
    public List<ContactRecord> list(String sessionId, ListContactsQuery query) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts",
            query,
            null,
            ContactRecord.class);
    }

    /** Get details for a single contact by id (JID). */
    public ContactRecord get(String sessionId, String contactId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId),
            null,
            null,
            ContactRecord.class);
    }

    /** Check whether a phone number is registered on WhatsApp. */
    public CheckNumberResponse check(String sessionId, String number) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/check/" + encodeSegment(number),
            null,
            null,
            CheckNumberResponse.class);
    }

    /** Get the contact's profile picture URL (or null). */
    public ProfilePictureResponse profilePicture(String sessionId, String contactId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId) + "/profile-picture",
            null,
            null,
            ProfilePictureResponse.class);
    }

    /**
     * Batch-resolve profile picture URLs for up to 50 contacts in one request.
     * Returns a map of contact id → URL (null when a lookup fails).
     */
    public ProfilePicturesResponse profilePictures(String sessionId, List<String> ids) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/profile-pictures",
            Map.of("ids", String.join(",", ids)),
            null,
            ProfilePicturesResponse.class);
    }

    /** Resolve a contact id (e.g. a {@code @lid}) to a phone number. */
    public ContactPhoneResponse phone(String sessionId, String contactId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId) + "/phone",
            null,
            null,
            ContactPhoneResponse.class);
    }

    /** Block a contact. Requires an OPERATOR-level key. */
    public SuccessResult block(String sessionId, String contactId) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId) + "/block",
            null,
            null,
            SuccessResult.class);
    }

    /** Save a contact to the addressbook, or edit an existing entry. Requires an OPERATOR key. */
    public SuccessResult upsert(String sessionId, String contactId, UpsertContactRequest body) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId),
            null,
            body,
            SuccessResult.class);
    }

    /** Remove a contact from the addressbook. Requires an OPERATOR key. */
    public SuccessResult delete(String sessionId, String contactId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId),
            null,
            null,
            SuccessResult.class);
    }

    /** Unblock a contact. Requires an OPERATOR-level key. */
    public SuccessResult unblock(String sessionId, String contactId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/contacts/" + encodeSegment(contactId) + "/block",
            null,
            null,
            SuccessResult.class);
    }
}
