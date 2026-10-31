import { describe, expect, it } from 'vitest';
import { OpenWAClient } from '../src';
import type { WebhookFilters } from '../src/types';
import { MockTransport } from './helpers';

function client(t: MockTransport): OpenWAClient {
  return new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: t.asFetch() });
}

describe('GroupsResource — exact paths and bodies', () => {
  it('list / get / create', async () => {
    const t = new MockTransport()
      .on('GET', /\/groups$/, { body: [] })
      .on('GET', /\/groups\/g1@g\.us$/, { body: { id: 'g1@g.us', name: 'G', participants: [] } })
      .on('POST', /\/groups$/, { body: { id: 'g1@g.us', name: 'G', participants: [] } });
    const c = client(t);
    await c.groups.list('s');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups');
    await c.groups.get('s', 'g1@g.us');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups/g1@g.us');
    await c.groups.create('s', { name: 'G', participants: ['a@c.us'] });
    expect(t.lastCall!.body).toEqual({ name: 'G', participants: ['a@c.us'] });
  });

  it('participant ops wrap participants in a body', async () => {
    const t = new MockTransport()
      .on('POST', /\/participants$/, { body: { success: true, message: 'added' } })
      .on('DELETE', /\/participants$/, { body: { success: true } })
      .on('POST', /\/participants\/promote$/, { body: { success: true } })
      .on('POST', /\/participants\/demote$/, { body: { success: true } });
    const c = client(t);
    await c.groups.addParticipants('s', 'g1@g.us', ['a@c.us', 'b@c.us']);
    expect(t.lastCall!.body).toEqual({ participants: ['a@c.us', 'b@c.us'] });
    expect(t.lastCall!.method).toBe('POST');
    await c.groups.removeParticipants('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.method).toBe('DELETE');
    await c.groups.promoteParticipants('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.url).toContain('/participants/promote');
    await c.groups.demoteParticipants('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.url).toContain('/participants/demote');
  });

  it('subject / description / leave / inviteCode / revoke', async () => {
    const t = new MockTransport()
      .on('PUT', /\/subject$/, { body: { success: true } })
      .on('PUT', /\/description$/, { body: { success: true } })
      .on('POST', /\/leave$/, { body: { success: true } })
      .on('GET', /\/invite-code$/, { body: { inviteCode: 'c', inviteLink: 'l' } })
      .on('POST', /\/invite-code\/revoke$/, { body: { inviteCode: 'c2', inviteLink: 'l2' } });
    const c = client(t);
    await c.groups.setSubject('s', 'g', 'New');
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.body).toEqual({ subject: 'New' });
    await c.groups.setDescription('s', 'g', 'desc');
    expect(t.lastCall!.body).toEqual({ description: 'desc' });
    await c.groups.leave('s', 'g');
    await c.groups.inviteCode('s', 'g');
    await c.groups.revokeInviteCode('s', 'g');
    expect(t.lastCall!.url).toContain('/invite-code/revoke');
  });

  it('setMemberLabel PUTs the label to the group', async () => {
    const t = new MockTransport().on('PUT', /\/member-label$/, { body: { success: true } });
    await client(t).groups.setMemberLabel('s', 'g@g.us', 'Site A');
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.url).toContain('/api/sessions/s/groups/g@g.us/member-label');
    expect(t.lastCall!.body).toEqual({ label: 'Site A' });
  });

  it('membership requests — list, approve, reject', async () => {
    const t = new MockTransport()
      .on('GET', /\/membership-requests$/, { body: [{ participantId: 'a@c.us', method: 'invite_link' }] })
      .on('POST', /\/membership-requests\/approve$/, { body: { success: true, message: 'ok', results: [] } })
      .on('POST', /\/membership-requests\/reject$/, { body: { success: true, message: 'ok', results: [] } });
    const c = client(t);

    const pending = await c.groups.getMembershipRequests('s', 'g1@g.us');
    expect(t.lastCall!.method).toBe('GET');
    expect(t.lastCall!.url).toContain('/groups/g1@g.us/membership-requests');
    expect(pending[0].participantId).toBe('a@c.us');

    await c.groups.approveMembershipRequests('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.url).toContain('/membership-requests/approve');
    expect(t.lastCall!.body).toEqual({ participants: ['a@c.us'] });

    // Omitting the list means "every pending request" — it must send an empty object, not
    // `{ participants: undefined }`, which would read as an explicit empty selection.
    await c.groups.rejectMembershipRequests('s', 'g1@g.us');
    expect(t.lastCall!.url).toContain('/membership-requests/reject');
    expect(t.lastCall!.body).toEqual({});
  });

  it('joinGroup posts the invite code to /groups/join', async () => {
    const t = new MockTransport().on('POST', /\/groups\/join$/, { body: { success: true, groupId: 'g1@g.us' } });
    const res = await client(t).groups.joinGroup('s', { inviteCode: 'AbCdEf' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups/join');
    expect(t.lastCall!.body).toEqual({ inviteCode: 'AbCdEf' });
    expect(res.groupId).toBe('g1@g.us');
  });

  it('getGroupSettings / updateGroupSettings hit /groups/:id/settings', async () => {
    const t = new MockTransport()
      .on('GET', /\/groups\/g1@g\.us\/settings$/, { body: { announce: true, ephemeralSeconds: 604800 } })
      .on('PUT', /\/groups\/g1@g\.us\/settings$/, { body: { success: true, message: 'Group settings updated' } });
    const c = client(t);
    const settings = await c.groups.getGroupSettings('s', 'g1@g.us');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups/g1@g.us/settings');
    expect(settings.announce).toBe(true);
    expect(settings.ephemeralSeconds).toBe(604800);
    await c.groups.updateGroupSettings('s', 'g1@g.us', { locked: true });
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.body).toEqual({ locked: true });
  });
});

describe('ProfileResource — exact paths and bodies', () => {
  it('setProfileName / setProfileStatus / setProfilePicture PUT to /profile/*', async () => {
    const t = new MockTransport()
      .on('PUT', /\/profile\/name$/, { body: { success: true, message: 'Profile name updated' } })
      .on('PUT', /\/profile\/status$/, { body: { success: true, message: 'Profile status updated' } })
      .on('PUT', /\/profile\/picture$/, { body: { success: true, message: 'Profile picture updated' } });
    const c = client(t);
    await c.profile.setProfileName('s', 'My Bot');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/profile/name');
    expect(t.lastCall!.body).toEqual({ name: 'My Bot' });
    await c.profile.setProfileStatus('s', '');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/profile/status');
    expect(t.lastCall!.body).toEqual({ status: '' });
    await c.profile.setProfilePicture('s', { url: 'https://e.com/avatar.jpg' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/profile/picture');
    expect(t.lastCall!.body).toEqual({ url: 'https://e.com/avatar.jpg' });
  });

  it('setProfilePicture forwards the base64 + mimetype variant verbatim', async () => {
    const t = new MockTransport().on('PUT', /\/profile\/picture$/, { body: { success: true } });
    await client(t).profile.setProfilePicture('s', { base64: 'aGVsbG8=', mimetype: 'image/png' });
    expect(t.lastCall!.body).toEqual({ base64: 'aGVsbG8=', mimetype: 'image/png' });
  });
  it('deleteProfilePicture sends DELETE to the picture route with no body', async () => {
    const t = new MockTransport().on('DELETE', /\/profile\/picture$/, { body: { success: true } });
    await client(t).profile.deleteProfilePicture('s');
    expect(t.lastCall!.method).toBe('DELETE');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/profile/picture');
    expect(t.lastCall!.body).toBeUndefined();
  });
});

describe('CallsResource — exact paths', () => {
  it('rejectCall POSTs to /calls/:callId/reject with no body', async () => {
    const t = new MockTransport().on('POST', /\/calls\/CALL123\/reject$/, { body: { success: true } });
    const res = await client(t).calls.rejectCall('s', 'CALL123');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/calls/CALL123/reject');
    expect(t.lastCall!.body).toBeUndefined();
    expect(res.success).toBe(true);
  });
});

describe('MediaResource — exact paths', () => {
  it('conversionStatus GETs the convert root', async () => {
    const t = new MockTransport().on('GET', /\/media\/convert$/, { body: { available: true } });
    const res = await client(t).media.conversionStatus('s');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/media/convert');
    expect(res.available).toBe(true);
  });

  it('convertVoice POSTs the media to /convert/voice and returns the converted bytes', async () => {
    const t = new MockTransport().on('POST', /\/media\/convert\/voice$/, {
      body: { base64: 'T2dnUw==', mimetype: 'audio/ogg; codecs=opus', bytes: 8 },
    });
    const res = await client(t).media.convertVoice('s', { base64: 'SUQz' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/media/convert/voice');
    expect(t.lastCall!.body).toEqual({ base64: 'SUQz' });
    expect(res.mimetype).toBe('audio/ogg; codecs=opus');
  });

  it('convertVideo forwards a url variant verbatim', async () => {
    const t = new MockTransport().on('POST', /\/media\/convert\/video$/, {
      body: { base64: 'AAAA', mimetype: 'video/mp4', bytes: 4 },
    });
    await client(t).media.convertVideo('s', { url: 'https://example.com/clip.mov' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/media/convert/video');
    expect(t.lastCall!.body).toEqual({ url: 'https://example.com/clip.mov' });
  });
});

describe('ContactsResource — exact paths', () => {
  it('list / get / check / profilePicture / phone', async () => {
    const t = new MockTransport()
      .on('GET', /\/contacts$/, { body: [] })
      .on('GET', /\/contacts\/[^/]+$/, { body: { id: 'a@c.us' } })
      .on('GET', /\/check\/628123$/, { body: { number: '628123', exists: true, whatsappId: '628123@c.us' } })
      .on('GET', /\/profile-picture$/, { body: { url: 'http://p' } })
      .on('GET', /\/phone$/, { body: { contactId: 'x@lid', phone: '628123' } });
    const c = client(t);
    await c.contacts.list('s', { limit: 10 });
    expect(t.lastCall!.url).toContain('limit=10');
    await c.contacts.get('s', 'a@c.us');
    await c.contacts.check('s', '628123');
    expect(t.lastCall!.url).toContain('/check/628123');
    await c.contacts.profilePicture('s', 'a@c.us');
    await c.contacts.phone('s', 'x@lid');
  });

  it('block (POST) / unblock (DELETE)', async () => {
    const t = new MockTransport()
      .on('POST', /\/block$/, { body: { success: true } })
      .on('DELETE', /\/block$/, { body: { success: true } });
    const c = client(t);
    await c.contacts.block('s', 'a@c.us');
    expect(t.lastCall!.method).toBe('POST');
    await c.contacts.unblock('s', 'a@c.us');
    expect(t.lastCall!.method).toBe('DELETE');
  });

  it('listBlocked — GET the session-wide blocked list, no contact id and no body', async () => {
    const t = new MockTransport().on('GET', /\/contacts\/blocked$/, { body: ['a@c.us', 'b@c.us'] });
    const res = await client(t).contacts.listBlocked('s');

    expect(t.lastCall!.method).toBe('GET');
    // Session-wide: no contact id in the path, and not the /contacts list route either.
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/contacts/blocked');
    expect(t.lastCall!.body).toBeUndefined();
    expect(res).toEqual(['a@c.us', 'b@c.us']);
  });

  it('profilePictures batch-resolves ids via the ids query param', async () => {
    const t = new MockTransport().on('GET', /\/contacts\/profile-pictures$/, {
      body: { pictures: { 'a@c.us': 'http://p/a', 'b@c.us': null } },
    });
    const res = await client(t).contacts.profilePictures('s', ['a@c.us', 'b@c.us']);
    expect(t.lastCall!.method).toBe('GET');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/contacts/profile-pictures?ids=a%40c.us%2Cb%40c.us');
    expect(res.pictures).toEqual({ 'a@c.us': 'http://p/a', 'b@c.us': null });
  });
});

describe('WebhooksResource — exact paths', () => {
  it('list/get/create/update/delete/test', async () => {
    const t = new MockTransport()
      .on('GET', /\/webhooks$/, { body: [] })
      .on('GET', /\/webhooks\/w1$/, {
        body: { id: 'w1', sessionId: 's', url: 'u', events: ['*'], active: true, createdAt: '', updatedAt: '' },
      })
      .on('POST', /\/webhooks$/, {
        body: {
          id: 'w1',
          sessionId: 's',
          url: 'u',
          events: ['*'],
          active: true,
          retryCount: 5,
          lastTriggeredAt: null,
          createdAt: '',
          updatedAt: '',
        },
      })
      .on('PUT', /\/webhooks\/w1$/, {
        body: { id: 'w1', sessionId: 's', url: 'u', events: ['*'], active: false, createdAt: '', updatedAt: '' },
      })
      .on('DELETE', /\/webhooks\/w1$/, { status: 204 })
      .on('POST', /\/webhooks\/w1\/test$/, { body: { success: true } });
    const c = client(t);
    await c.webhooks.list('s');
    await c.webhooks.get('s', 'w1');
    // Server DTO field is `retryCount` (NOT `retries`) — body must forward verbatim.
    const created = await c.webhooks.create('s', { url: 'u', events: ['*'], retryCount: 5 });
    expect(t.lastCall!.body).toEqual({ url: 'u', events: ['*'], retryCount: 5 });
    // Response exposes retryCount and lastTriggeredAt; secret/headers are stripped server-side.
    expect(created.retryCount).toBe(5);
    expect(created.lastTriggeredAt).toBeNull();
    await c.webhooks.update('s', 'w1', { active: false });
    expect(t.lastCall!.method).toBe('PUT');
    await c.webhooks.delete('s', 'w1');
    await c.webhooks.test('s', 'w1');
    expect(t.lastCall!.url).toContain('/webhooks/w1/test');
  });

  it('create forwards polymorphic filter values (string, string[], boolean) verbatim', async () => {
    const t = new MockTransport().on('POST', /\/webhooks$/, {
      body: { id: 'w1', sessionId: 's', url: 'u', events: ['*'], active: true, createdAt: '', updatedAt: '' },
    });
    const filters: WebhookFilters = {
      conditions: [
        { field: 'sender', operator: 'is', value: ['123@c.us'] },
        { field: 'body', operator: 'contains', value: 'invoice', caseSensitive: true },
        { field: 'isGroup', operator: 'is', value: false },
      ],
    };
    await client(t).webhooks.create('s', { url: 'u', events: ['message.received'], filters });
    expect(t.lastCall!.body).toEqual({ url: 'u', events: ['message.received'], filters });
  });

  it('redriveDeliveryFailures POSTs the filter (or an empty body) to the redrive route', async () => {
    const result = { redriven: 1, delivered: 1, enqueued: 0, failed: 0, skipped: 0, remaining: 0 };
    const t = new MockTransport().on('POST', /\/api\/webhooks\/delivery-failures\/redrive$/, { body: result });
    const c = client(t);
    await expect(c.webhooks.redriveDeliveryFailures({ sessionId: 's', limit: 10 })).resolves.toEqual(result);
    expect(t.lastCall!.body).toEqual({ sessionId: 's', limit: 10 });
    await c.webhooks.redriveDeliveryFailures();
    expect(t.lastCall!.body).toEqual({});
  });

  // The gateway reads `ids: []` as "replay nothing" and an omitted `ids` as "replay up to 100 rows", so
  // an SDK that drops the empty array would turn a deliberate empty selection into a real replay.
  it('redriveDeliveryFailures keeps an explicit empty ids list', async () => {
    const result = { redriven: 0, delivered: 0, enqueued: 0, failed: 0, skipped: 0, remaining: 3 };
    const t = new MockTransport().on('POST', /\/api\/webhooks\/delivery-failures\/redrive$/, { body: result });
    await client(t).webhooks.redriveDeliveryFailures({ ids: [] });
    expect(t.lastCall!.body).toEqual({ ids: [] });
  });
});

describe('StatusResource — nested media bodies', () => {
  it('sendImage/sendVideo forward the server-required nested {image|video:{...}} shape', async () => {
    const t = new MockTransport()
      .on('POST', /\/status\/send-image$/, {
        body: { statusId: 's1', timestamp: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' },
      })
      .on('POST', /\/status\/send-video$/, {
        body: { statusId: 's2', timestamp: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' },
      });
    const c = client(t);
    await c.status.sendImage('s', { image: { url: 'http://img' }, recipients: ['a@c.us'], caption: 'hi' });
    expect(t.lastCall!.body).toEqual({ image: { url: 'http://img' }, recipients: ['a@c.us'], caption: 'hi' });
    await c.status.sendVideo('s', { video: { url: 'http://vid' }, recipients: ['a@c.us'] });
    expect(t.lastCall!.body).toEqual({ video: { url: 'http://vid' }, recipients: ['a@c.us'] });
  });

  // A voice status wraps its media under `audio` and carries no caption at all.
  it('sendVoice forwards the audio wrapper to send-voice', async () => {
    const t = new MockTransport().on('POST', /\/status\/send-voice$/, {
      body: { statusId: 's3', timestamp: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' },
    });
    await client(t).status.sendVoice('s', { audio: { base64: 'T2dnUw==' }, recipients: ['a@c.us'] });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/status/send-voice');
    expect(t.lastCall!.body).toEqual({ audio: { base64: 'T2dnUw==' }, recipients: ['a@c.us'] });
  });

  it('votePoll posts the option texts', async () => {
    const t = new MockTransport().on('POST', /\/messages\/vote-poll$/, { body: { success: true } });
    await client(t).messages.votePoll('s', { chatId: 'c1', pollMessageId: 'p1', options: ['Pizza'] });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/vote-poll');
    expect(t.lastCall!.body).toEqual({ chatId: 'c1', pollMessageId: 'p1', options: ['Pizza'] });
  });

  it('star posts the boolean through', async () => {
    const t = new MockTransport().on('POST', /\/messages\/star$/, { body: { success: true } });
    await client(t).messages.star('s', { chatId: 'c1', messageId: 'm1', star: false });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/star');
    expect(t.lastCall!.body).toEqual({ chatId: 'c1', messageId: 'm1', star: false });
  });

  it('pin and unpin post to their own routes', async () => {
    const t = new MockTransport().on('POST', /\/messages\/(un)?pin$/, { body: { success: true } });
    const c = client(t);
    await c.messages.pin('s', { chatId: 'c1', messageId: 'm1', durationSeconds: 604800 });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/pin');
    expect(t.lastCall!.body).toEqual({ chatId: 'c1', messageId: 'm1', durationSeconds: 604800 });
    await c.messages.unpin('s', { chatId: 'c1', messageId: 'm1' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/unpin');
  });

  it('message media fetches the archived bytes with their content type', async () => {
    const t = new MockTransport().on('GET', /\/messages\/c1\/m1\/media$/, {
      text: 'PNG_BYTES',
      contentType: 'image/png',
    });
    const res = await client(t).messages.media('s', 'c1', 'm1');
    expect(t.lastCall!.method).toBe('GET');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/c1/m1/media');
    expect(res.contentType).toBe('image/png');
  });

  it('media fetches the stored status bytes with their content type', async () => {
    const t = new MockTransport().on('GET', /\/status\/w1\/media$/, { text: 'PNG_BYTES', contentType: 'image/png' });
    const res = await client(t).status.media('s', 'w1');
    expect(t.lastCall!.method).toBe('GET');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/status/w1/media');
    expect(new TextDecoder().decode(res.data)).toBe('PNG_BYTES');
    expect(res.contentType).toBe('image/png');
  });
});

describe('ChatsResource — exact paths', () => {
  it('list / markRead / markUnread / delete / sendState', async () => {
    const t = new MockTransport()
      .on('GET', /\/chats$/, { body: [] })
      .on('POST', /\/chats\/read$/, { body: { success: true } })
      .on('POST', /\/chats\/unread$/, { body: { success: true } })
      .on('POST', /\/chats\/delete$/, { body: { success: true } })
      .on('POST', /\/chats\/typing$/, { body: { success: true } });
    const c = client(t);
    await c.chats.list('s');
    await c.chats.markRead('s', { chatId: 'a@c.us' });
    expect(t.lastCall!.url).toContain('/chats/read');
    await c.chats.markUnread('s', { chatId: 'a@c.us' });
    await c.chats.delete('s', { chatId: 'a@c.us' });
    await c.chats.sendState('s', { chatId: 'a@c.us', state: 'typing' });
    expect(t.lastCall!.url).toContain('/chats/typing');
  });
});

describe('ChatsResource last-message metadata', () => {
  it('keeps media types and omitted metadata from the server response', async () => {
    const t = new MockTransport().on('GET', /\/chats$/, {
      body: [{ id: 'photo@c.us', lastMessageType: 'image' }, { id: 'empty@c.us' }],
    });
    const chats = await client(t).chats.list('s');
    expect(chats[0].lastMessageType).toBe('image');
    expect(chats[1].lastMessageType).toBeUndefined();
  });
});

describe('ChatsResource.clearMessages', () => {
  it('DELETEs the chat messages sub-resource', async () => {
    const t = new MockTransport().on('DELETE', /\/chats\/.+\/messages$/, { body: { success: true } });
    await client(t).chats.clearMessages('s', 'a@c.us');
    expect(t.lastCall!.method).toBe('DELETE');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/chats/a@c.us/messages');
  });
});

describe('GroupsResource picture', () => {
  it('GETs, PUTs and DELETEs the picture sub-resource', async () => {
    const t = new MockTransport()
      .on('GET', /\/groups\/[^/]+\/picture$/, { body: { url: 'https://x/p.jpg' } })
      .on('PUT', /\/groups\/[^/]+\/picture$/, { body: { success: true } })
      .on('DELETE', /\/groups\/[^/]+\/picture$/, { body: { success: true } });
    const c = client(t);
    expect(await c.groups.getPicture('s', 'g@g.us')).toEqual({ url: 'https://x/p.jpg' });
    await c.groups.setPicture('s', 'g@g.us', { url: 'https://x/new.jpg' });
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups/g@g.us/picture');
    await c.groups.deletePicture('s', 'g@g.us');
    expect(t.lastCall!.method).toBe('DELETE');
  });
});

describe('ContactsResource addressbook', () => {
  it('PUTs the contact and DELETEs it by the same path', async () => {
    const t = new MockTransport()
      .on('PUT', /\/contacts\/[^/]+$/, { body: { success: true } })
      .on('DELETE', /\/contacts\/[^/]+$/, { body: { success: true } });
    const c = client(t);
    await c.contacts.upsert('s', 'a@c.us', { firstName: 'Ada' });
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/contacts/a@c.us');
    expect(t.lastCall!.body).toEqual({ firstName: 'Ada' });
    await c.contacts.delete('s', 'a@c.us');
    expect(t.lastCall!.method).toBe('DELETE');
  });
});

describe('ChatsResource.archive', () => {
  it('posts chatId and the archive flag', async () => {
    const t = new MockTransport().on('POST', /\/chats\/archive$/, { body: { success: true } });
    await client(t).chats.archive('s', { chatId: 'a@c.us', archive: true });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/chats/archive');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', archive: true });
  });
});

describe('ChatsResource.pin', () => {
  it('posts chatId and the pin flag', async () => {
    const t = new MockTransport().on('POST', /\/chats\/pin$/, { body: { success: true } });
    await client(t).chats.pin('s', { chatId: 'a@c.us', pin: true });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/chats/pin');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', pin: true });
  });

  it('reports the three-pin refusal rather than throwing', async () => {
    const t = new MockTransport().on('POST', /\/chats\/pin$/, { body: { success: false } });
    await expect(client(t).chats.pin('s', { chatId: 'a@c.us', pin: true })).resolves.toEqual({ success: false });
  });
});

describe('ChatsResource.mute', () => {
  // muteUntil must survive as the exact epoch-millisecond number given. A client that divided by
  // 1000, or stringified it, would still get a 200 back — the wrong unit is only visible here.
  it('sends muteUntil as epoch milliseconds, unchanged', async () => {
    const t = new MockTransport().on('POST', /\/chats\/mute$/, { body: { success: true } });
    await client(t).chats.mute('s', { chatId: 'a@c.us', muteUntil: 1893456000000 });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/chats/mute');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', muteUntil: 1893456000000 });
  });

  // null is the unmute signal and is NOT the same as omitting the field, which the route rejects.
  it('sends an explicit null to unmute rather than dropping the key', async () => {
    const t = new MockTransport().on('POST', /\/chats\/mute$/, { body: { success: true } });
    await client(t).chats.mute('s', { chatId: 'a@c.us', muteUntil: null });
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', muteUntil: null });
    expect(Object.keys(t.lastCall!.body as object)).toContain('muteUntil');
  });
});

describe('HealthResource + auth — exact paths', () => {
  it('health/live/ready and auth validate', async () => {
    const t = new MockTransport()
      .on('GET', /\/health$/, { body: { status: 'ok', version: '0.7.2' } })
      .on('GET', /\/health\/live$/, { body: { status: 'ok' } })
      .on('GET', /\/health\/ready$/, { body: { status: 'ok', details: {} } })
      .on('POST', /\/auth\/validate$/, { body: { valid: true, role: 'admin', scoped: true } });
    const c = client(t);
    await c.health.check();
    expect(t.lastCall!.url).toBe('http://x/api/health');
    await c.health.live();
    await c.health.ready();
    expect((await c.auth()).scoped).toBe(true);
    expect(t.lastCall!.method).toBe('POST');
    expect(t.lastCall!.url).toBe('http://x/api/auth/validate');
  });
});

describe('CallsResource — call link', () => {
  it('createLink posts to /calls/link with the type and start time', async () => {
    const t = new MockTransport().on('POST', /\/calls\/link$/, {
      body: { link: 'https://call.whatsapp.com/video/AbC' },
    });
    const res = await client(t).calls.createLink('s', { type: 'video', startTime: 1800000000000 });

    expect(t.lastCall!.method).toBe('POST');
    // Session-wide: no call id in the path, and not the reject route.
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/calls/link');
    expect(t.lastCall!.body).toEqual({ type: 'video', startTime: 1800000000000 });
    expect(res.link).toContain('call.whatsapp.com');
  });
});

describe('SearchResource — exact path and query forwarding', () => {
  it('forwards params as a query string to /api/search', async () => {
    const t = new MockTransport().on('GET', /\/search$/, {
      body: { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' },
    });
    const c = client(t);
    const res = await c.search.search({ q: 'hello', sessionId: 's1', limit: 10, offset: 0 });
    expect(t.lastCall!.method).toBe('GET');
    expect(t.lastCall!.url).toBe('http://x/api/search?q=hello&sessionId=s1&limit=10&offset=0');
    expect(res.provider).toBe('builtin-fts');
    expect(res.total).toBe(0);
  });

  it('omits undefined optional filters from the query string', async () => {
    const t = new MockTransport().on('GET', /\/search$/, {
      body: { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' },
    });
    const c = client(t);
    await c.search.search({ q: 'term', chatId: '628@c.us', direction: 'incoming' });
    expect(t.lastCall!.url).toBe('http://x/api/search?q=term&chatId=628%40c.us&direction=incoming');
  });

  it('forwards the match mode', async () => {
    const t = new MockTransport().on('GET', /\/search$/, {
      body: { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' },
    });
    await client(t).search.search({ q: 'voic', match: 'contains' });
    expect(t.lastCall!.url).toBe('http://x/api/search?q=voic&match=contains');
  });
});

// Eleven routes no other test calls. Each row is written from the contract (openapi.json: verb, path,
// query and request-body keys), not read off the client, so a changed verb or a renamed body key fails here.
describe('routes with no other test: verb, path, query and body', () => {
  type Row = [name: string, call: (c: OpenWAClient) => Promise<unknown>, method: string, url: string, body?: unknown];
  const rows: Row[] = [
    ['sessions.getConfig', c => c.sessions.getConfig('s1'), 'GET', 'http://x/api/sessions/s1/config'],
    [
      'sessions.updateConfig',
      c =>
        c.sessions.updateConfig('s1', { autoRejectCalls: true, maxReconnectAttempts: null, reconnectBaseDelay: 2000 }),
      'PATCH',
      'http://x/api/sessions/s1/config',
      { autoRejectCalls: true, maxReconnectAttempts: null, reconnectBaseDelay: 2000 },
    ],
    ['sessions.getProxy', c => c.sessions.getProxy('s1'), 'GET', 'http://x/api/sessions/s1/proxy'],
    [
      'sessions.updateProxy',
      c => c.sessions.updateProxy('s1', { proxyUrl: null }),
      'PATCH',
      'http://x/api/sessions/s1/proxy',
      { proxyUrl: null },
    ],
    [
      'webhooks.listAll',
      c => c.webhooks.listAll({ limit: 5, offset: 10 }),
      'GET',
      'http://x/api/webhooks?limit=5&offset=10',
    ],
    [
      'webhooks.deliveryFailures',
      c => c.webhooks.deliveryFailures({ sessionId: 's1', limit: 5, offset: 10 }),
      'GET',
      'http://x/api/webhooks/delivery-failures?sessionId=s1&limit=5&offset=10',
    ],
    [
      'chats.subscribePresence',
      c => c.chats.subscribePresence('s1', { chatId: 'a@c.us' }),
      'POST',
      'http://x/api/sessions/s1/presence/subscribe',
      { chatId: 'a@c.us' },
    ],
    ['chats.getPresence', c => c.chats.getPresence('s1', 'a@c.us'), 'GET', 'http://x/api/sessions/s1/presence/a@c.us'],
    ['status.fromContact', c => c.status.fromContact('s1', 'a@c.us'), 'GET', 'http://x/api/sessions/s1/status/a@c.us'],
    ['labels.chats', c => c.labels.chats('s1', 'l1'), 'GET', 'http://x/api/sessions/s1/labels/l1/chats'],
    [
      'groups.joinInfo',
      c => c.groups.joinInfo('s1', 'INVITE'),
      'GET',
      'http://x/api/sessions/s1/groups/join-info?code=INVITE',
    ],
  ];

  it.each(rows)('%s', async (_name, call, method, url, body) => {
    const t = new MockTransport().passthrough({ status: 200, body: {} });
    await call(client(t));
    expect(t.calls).toHaveLength(1);
    expect(t.lastCall!.method).toBe(method);
    expect(t.lastCall!.url).toBe(url);
    expect(t.lastCall!.body).toEqual(body);
  });
});
