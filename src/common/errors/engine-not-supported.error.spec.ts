import { EngineNotSupportedError } from './engine-not-supported.error';

describe('EngineNotSupportedError', () => {
  it('carries HTTP 501 so NestJS returns Not Implemented without a custom filter', () => {
    expect(new EngineNotSupportedError('getGroups').getStatus()).toBe(501);
  });

  it('names the unsupported operation in the message', () => {
    expect(new EngineNotSupportedError('getGroups').message).toContain('getGroups');
  });
});
