import { z } from 'zod';
import { DEFAULT_LIST_LIMIT } from '../../common/utils/paginate';
import { allAgentTools, type AgentToolDeps } from './tools';

// These tools answer a bare array: no total comes with it, so an agent that reads a full page as the whole list
// reports a truncated address book or group list as complete.
describe('list tools that answer a bare array', () => {
  const tools = allAgentTools(new Proxy({}, { get: () => ({}) }) as unknown as AgentToolDeps);
  const limitOf = (name: string): { description?: string; maximum?: number } => {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as {
      properties: Record<string, { description?: string; maximum?: number }>;
    };
    return schema.properties.limit;
  };

  it.each(['SessionFindAll', 'SessionGetChats', 'ContactFindAll', 'GroupFindAll', 'WebhooksList'])(
    '%s says how many rows a call returns and that a full page may not be the whole list',
    name => {
      const limit = limitOf(name);
      expect(limit.maximum).toBe(DEFAULT_LIST_LIMIT);
      expect(limit.description).toContain(`${DEFAULT_LIST_LIMIT} when omitted`);
      expect(limit.description).toContain('ask again with offset');
    },
  );
});
