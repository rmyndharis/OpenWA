import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LabelService } from './label.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('LabelService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const engines = new EngineRegistry();
    if (engine) engines.set('s1', engine as IWhatsAppEngine);
    return new LabelService(engines);
  };

  it('throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).getLabels('s1')).toThrow(BadRequestException);
  });

  it('maps a missing label to 404', async () => {
    const svc = makeService({ getLabelById: jest.fn().mockResolvedValue(null) });
    await expect(svc.getLabelById('s1', 'l404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delegates addLabelToChat to the engine', async () => {
    const addLabelToChat = jest.fn().mockResolvedValue(undefined);
    await makeService({ addLabelToChat }).addLabelToChat('s1', 'chat1', 'l1');
    expect(addLabelToChat).toHaveBeenCalledWith('chat1', 'l1');
  });
});
