import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { StatusController } from '../status.controller';
import { StatusService } from '../status.service';

/**
 * The status media posts take base64 without a mimetype and fall back to the type of the endpoint
 * (image/jpeg, video/mp4, audio/ogg; codecs=opus). The published schema must not tell a client otherwise.
 */
describe('StatusMediaInput in the published API description', () => {
  it('describes the mimetype as optional, with the endpoint default applied when it is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StatusController],
      providers: [{ provide: StatusService, useValue: {} }],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    await app.close();

    const schema = document.components?.schemas?.StatusMediaInput as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.base64.description).not.toMatch(/requir/i);
    expect(schema.properties.mimetype.description).not.toMatch(/requir/i);
    expect(schema.properties.mimetype.description).toMatch(/default/i);
  });
});
