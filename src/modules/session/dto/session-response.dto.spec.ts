import { SessionResponseDto } from './session-response.dto';

const published = (name: string): { description: string } =>
  Reflect.getMetadata('swagger/apiModelProperties', SessionResponseDto.prototype, name) as { description: string };

describe('SessionResponseDto.engineLoaded', () => {
  // With no engine in memory start can act and logout and force-kill answer 400, but stop answers 200 and records the
  // stop (see session-lifecycle-without-engine.spec.ts), so "the reverse" of the loaded case is not what happens.
  it('says what stop does while no engine is loaded', () => {
    const { description } = published('engineLoaded');

    expect(description).toContain('`stop` still answers 200 and records the stop');
    expect(description).not.toContain('means the reverse');
  });
});
