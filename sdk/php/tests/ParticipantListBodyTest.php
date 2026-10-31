<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

/**
 * A participant list is sent as a JSON array whatever its keys. array_unique() and array_filter()
 * keep the original keys, and json_encode() writes an array whose keys are not 0..n-1 as an object,
 * which the gateway refuses with 400 ("participants must be an array").
 */
class ParticipantListBodyTest extends TestCase
{
    /** @return array<string,array{0:string,1:string,2:string}> */
    public static function participantMethods(): array
    {
        return [
            'addParticipants' => ['addParticipants', 'POST', '/api/sessions/s/groups/g@g.us/participants'],
            'removeParticipants' => ['removeParticipants', 'DELETE', '/api/sessions/s/groups/g@g.us/participants'],
            'promoteParticipants' => ['promoteParticipants', 'POST', '/api/sessions/s/groups/g@g.us/participants/promote'],
            'demoteParticipants' => ['demoteParticipants', 'POST', '/api/sessions/s/groups/g@g.us/participants/demote'],
            'approveMembershipRequests' => ['approveMembershipRequests', 'POST', '/api/sessions/s/groups/g@g.us/membership-requests/approve'],
            'rejectMembershipRequests' => ['rejectMembershipRequests', 'POST', '/api/sessions/s/groups/g@g.us/membership-requests/reject'],
        ];
    }

    /**
     * @dataProvider participantMethods
     */
    public function testADeduplicatedListIsSentAsAJsonArray(string $method, string $verb, string $path): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true, 'results' => []]);
        $client = $backend->makeClient();

        // [0 => 'a@c.us', 2 => 'b@c.us']: the duplicate at key 1 is gone and key 2 stays.
        $participants = array_unique(['a@c.us', 'a@c.us', 'b@c.us']);
        $client->groups->{$method}('s', 'g@g.us', $participants);

        $this->assertSame($verb, $backend->lastCall()['method']);
        $this->assertSame($path, $backend->lastCall()['path']);
        $this->assertSame('{"participants":["a@c.us","b@c.us"]}', $backend->rawBody(0));
        $this->assertSame([0 => 'a@c.us', 2 => 'b@c.us'], $participants);
    }

    /**
     * @dataProvider participantMethods
     */
    public function testAStringKeyedListIsSentAsAJsonArray(string $method, string $verb, string $path): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true, 'results' => []]);
        $client = $backend->makeClient();

        $client->groups->{$method}('s', 'g@g.us', ['first' => 'a@c.us', 'second' => 'b@c.us']);

        $this->assertSame($verb, $backend->lastCall()['method']);
        $this->assertSame($path, $backend->lastCall()['path']);
        $this->assertSame('{"participants":["a@c.us","b@c.us"]}', $backend->rawBody(0));
    }
}
