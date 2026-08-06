import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from './engine-registry.service';
import type { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';

const engineStub = (tag: string): IWhatsAppEngine => ({ tag }) as unknown as IWhatsAppEngine;

describe('EngineRegistry', () => {
  let registry: EngineRegistry;

  beforeEach(() => {
    registry = new EngineRegistry();
  });

  describe('registration', () => {
    it('stores and returns the engine registered for a session', () => {
      const engine = engineStub('a');
      registry.set('s1', engine);

      expect(registry.get('s1')).toBe(engine);
      expect(registry.has('s1')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('reports an unregistered session as absent', () => {
      expect(registry.get('missing')).toBeUndefined();
      expect(registry.has('missing')).toBe(false);
    });

    it('replaces the engine on re-registration (reconnect installs a new generation)', () => {
      const first = engineStub('first');
      const second = engineStub('second');
      registry.set('s1', first);
      registry.set('s1', second);

      expect(registry.get('s1')).toBe(second);
      expect(registry.size).toBe(1);
    });

    it('clear() drops every engine', () => {
      registry.set('s1', engineStub('a'));
      registry.set('s2', engineStub('b'));

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.entries()).toEqual([]);
    });

    it('entries() snapshots the map so callers can tear down while it mutates', () => {
      const a = engineStub('a');
      registry.set('s1', a);

      const snapshot = registry.entries();
      registry.delete('s1');

      expect(snapshot).toEqual([['s1', a]]);
      expect(registry.size).toBe(0);
    });
  });

  describe('liveness by identity', () => {
    it('isLive() is true only for the currently registered instance', () => {
      const engine = engineStub('a');
      registry.set('s1', engine);

      expect(registry.isLive('s1', engine)).toBe(true);
    });

    it('isLive() is false for a superseded generation (reconnect replaced it)', () => {
      const stale = engineStub('stale');
      const fresh = engineStub('fresh');
      registry.set('s1', stale);
      registry.set('s1', fresh);

      expect(registry.isLive('s1', stale)).toBe(false);
      expect(registry.isLive('s1', fresh)).toBe(true);
    });

    it('isLive() is false after the session is stopped', () => {
      const engine = engineStub('a');
      registry.set('s1', engine);
      registry.delete('s1');

      expect(registry.isLive('s1', engine)).toBe(false);
    });

    it('deleteIfLive() reconciles the map for the live engine', () => {
      const engine = engineStub('a');
      registry.set('s1', engine);

      expect(registry.deleteIfLive('s1', engine)).toBe(true);
      expect(registry.has('s1')).toBe(false);
    });

    it('deleteIfLive() refuses to evict a live replacement on behalf of a stale engine', () => {
      const stale = engineStub('stale');
      const fresh = engineStub('fresh');
      registry.set('s1', stale);
      registry.set('s1', fresh);

      expect(registry.deleteIfLive('s1', stale)).toBe(false);
      expect(registry.get('s1')).toBe(fresh);
    });
  });

  describe('require()', () => {
    it('returns the engine when the session is started', () => {
      const engine = engineStub('a');
      registry.set('s1', engine);

      expect(registry.require('s1')).toBe(engine);
    });

    it('throws a 400 "not started" by default', () => {
      expect(() => registry.require('s1')).toThrow(BadRequestException);
      expect(() => registry.require('s1')).toThrow('Session is not started');
    });

    it('throws the caller-supplied error so each API keeps its documented status', () => {
      expect(() =>
        registry.require('s1', () => new NotFoundException('Session s1 not found or not connected')),
      ).toThrow(NotFoundException);
    });

    it('does not build the error when the engine is present', () => {
      const onMissing = jest.fn(() => new BadRequestException('nope'));
      registry.set('s1', engineStub('a'));

      registry.require('s1', onMissing);

      expect(onMissing).not.toHaveBeenCalled();
    });
  });

  describe('initialization reservations', () => {
    it('counts a reserved-but-unregistered session as active', () => {
      registry.initializing.add('s1');

      expect(registry.activeIds()).toEqual(['s1']);
      // Not yet a live engine: only the reservation exists.
      expect(registry.has('s1')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('does not double-count a session that is both reserved and registered', () => {
      registry.initializing.add('s1');
      registry.set('s1', engineStub('a'));

      expect(registry.activeIds()).toEqual(['s1']);
    });

    it('releases the reservation', () => {
      registry.initializing.add('s1');
      registry.initializing.delete('s1');

      expect(registry.activeIds()).toEqual([]);
    });

    it('reports registered and initializing sessions together', () => {
      registry.set('running', engineStub('a'));
      registry.initializing.add('starting');

      expect(registry.activeIds().sort()).toEqual(['running', 'starting']);
    });
  });
});
