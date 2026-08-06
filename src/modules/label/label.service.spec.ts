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

// Create and update are one operation upstream — a single `label_edit` write keyed on the label id —
// so the service must not invent two, and must not send fields the caller did not set.
describe('LabelService label editing', () => {
  const makeService = (engine: Partial<IWhatsAppEngine>) => {
    const engines = new EngineRegistry();
    engines.set('s1', engine as IWhatsAppEngine);
    return new LabelService(engines);
  };

  it('refuses an empty body — nothing to write, and an unused id would create a nameless label', () => {
    const upsertLabel = jest.fn();
    expect(() => makeService({ upsertLabel }).upsertLabel('s1', 'l1', {})).toThrow(BadRequestException);
    expect(upsertLabel).not.toHaveBeenCalled();
  });

  it('sends the path id as the label id', async () => {
    const upsertLabel = jest.fn().mockResolvedValue(undefined);
    await makeService({ upsertLabel }).upsertLabel('s1', 'l1', { name: 'VIP' });
    expect(upsertLabel).toHaveBeenCalledWith({ id: 'l1', name: 'VIP' });
  });

  // Omitted fields must stay omitted rather than becoming undefined-valued keys: the adapter drops
  // undefined before it reaches app-state, and sending an explicit blank would clear the field.
  it('passes through only the fields the caller set', async () => {
    const upsertLabel = jest.fn().mockResolvedValue(undefined);
    await makeService({ upsertLabel }).upsertLabel('s1', 'l1', { color: 3 });
    expect(upsertLabel).toHaveBeenCalledWith({ id: 'l1', color: 3 });
  });

  it('delegates deleteLabel to the engine', async () => {
    const deleteLabel = jest.fn().mockResolvedValue(undefined);
    await makeService({ deleteLabel }).deleteLabel('s1', 'l1');
    expect(deleteLabel).toHaveBeenCalledWith('l1');
  });

  it('delegates getChatsByLabel to the engine', async () => {
    const getChatsByLabel = jest.fn().mockResolvedValue([{ id: 'c@c.us' }]);
    await expect(makeService({ getChatsByLabel }).getChatsByLabel('s1', 'l1')).resolves.toEqual([{ id: 'c@c.us' }]);
    expect(getChatsByLabel).toHaveBeenCalledWith('l1');
  });

  it.each([
    ['upsertLabel', (svc: LabelService) => svc.upsertLabel('s1', 'l1', {})],
    ['deleteLabel', (svc: LabelService) => svc.deleteLabel('s1', 'l1')],
    ['getChatsByLabel', (svc: LabelService) => svc.getChatsByLabel('s1', 'l1')],
  ])('throws 400 for %s when the session is not started', (_name, call) => {
    const engines = new EngineRegistry();
    expect(() => call(new LabelService(engines))).toThrow(BadRequestException);
  });
});
