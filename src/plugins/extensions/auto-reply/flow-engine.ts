import { PluginContext } from '../../../core/plugins';

export interface FlowNode {
  text: string;
  options?: Record<string, FlowNode>;
}

export interface SessionFlow {
  enabled: boolean;
  trigger: string; // e.g. "hi", or empty for any message
  greeting: string;
  options?: Record<string, FlowNode>;
}

export interface FlowConfig {
  sessions?: Record<string, SessionFlow>;
}

export interface UserState {
  path: string[];
  lastActive: number;
}

export class FlowEngine {
  private static readonly TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes state expiration

  /**
   * Process an incoming message and send auto-replies according to configuration.
   * Returns true if a reply was sent, false otherwise.
   */
  public static async processMessage(
    context: PluginContext,
    sessionId: string,
    chatId: string,
    messageBody: string,
    messageId: string,
  ): Promise<boolean> {
    console.log(`[AutoReply] [FlowEngine] Processing message from session: ${sessionId}, chat: ${chatId}, body: "${messageBody}"`);
    const config = await context.storage.get<FlowConfig>('config');
    if (!config || !config.sessions || !config.sessions[sessionId]) {
      console.log(`[AutoReply] [FlowEngine] No config found for session ${sessionId}`);
      return false;
    }

    const sessionConfig = config.sessions[sessionId];
    if (!sessionConfig.enabled) {
      console.log(`[AutoReply] [FlowEngine] Session ${sessionId} flow is disabled`);
      return false;
    }

    const input = messageBody.trim();
    const stateKey = `state__${sessionId}__${chatId}`.replace(/:/g, '_');
    let state = await context.storage.get<UserState>(stateKey);
    console.log(`[AutoReply] [FlowEngine] Loaded state for key ${stateKey}:`, JSON.stringify(state));

    // Check expiration
    if (state && Date.now() - state.lastActive > this.TIMEOUT_MS) {
      console.log(`[AutoReply] [FlowEngine] Flow state expired for key ${stateKey}`);
      await context.storage.delete(stateKey);
      state = null;
    }

    const trigger = sessionConfig.trigger.trim();
    const isTriggerWord = trigger !== '' && input.toLowerCase() === trigger.toLowerCase();
    console.log(`[AutoReply] [FlowEngine] Trigger configured: "${trigger}", input: "${input}", isTriggerWord: ${isTriggerWord}`);

    // If no active flow state, check if we should start one
    if (!state) {
      if (trigger !== '' && !isTriggerWord) {
        console.log(`[AutoReply] [FlowEngine] No active state and input does not match trigger. Ignoring.`);
        return false; // Does not match trigger, ignore
      }
      // Start flow: send main greeting
      console.log(`[AutoReply] [FlowEngine] Starting new flow. Replying with greeting: "${sessionConfig.greeting}"`);
      await context.messages.reply(sessionId, chatId, messageId, sessionConfig.greeting);
      await context.storage.set(stateKey, {
        path: [],
        lastActive: Date.now(),
      });
      return true;
    }

    // If trigger word is received while in flow, restart the flow
    if (isTriggerWord) {
      console.log(`[AutoReply] [FlowEngine] Trigger word received during active flow. Restarting flow.`);
      await context.messages.reply(sessionId, chatId, messageId, sessionConfig.greeting);
      await context.storage.set(stateKey, {
        path: [],
        lastActive: Date.now(),
      });
      return true;
    }

    // Traverse the configuration options according to the user's path
    let currentNode: FlowNode | undefined = {
      text: sessionConfig.greeting,
      options: sessionConfig.options,
    };

    console.log(`[AutoReply] [FlowEngine] Traversing path:`, state.path);
    for (const key of state.path) {
      if (currentNode && currentNode.options && currentNode.options[key]) {
        currentNode = currentNode.options[key];
      } else {
        // State is invalid (e.g. config changed under the user). Reset.
        console.log(`[AutoReply] [FlowEngine] State path is invalid due to config mismatch. Resetting state.`);
        await context.storage.delete(stateKey);
        return this.processMessage(context, sessionId, chatId, messageBody, messageId);
      }
    }

    // Check if user input matches any option of the current node
    console.log(`[AutoReply] [FlowEngine] Current node options:`, currentNode.options ? Object.keys(currentNode.options) : 'none');
    const nextNode = currentNode.options ? currentNode.options[input] : undefined;

    if (nextNode) {
      console.log(`[AutoReply] [FlowEngine] Input matched option: "${input}". Replying with: "${nextNode.text}"`);
      // Transition state
      state.path.push(input);
      state.lastActive = Date.now();

      await context.messages.reply(sessionId, chatId, messageId, nextNode.text);

      // If next node has options, save the progress, otherwise delete the state to end the flow
      if (nextNode.options && Object.keys(nextNode.options).length > 0) {
        console.log(`[AutoReply] [FlowEngine] Next node has sub-options. Saving updated path.`);
        await context.storage.set(stateKey, state);
      } else {
        console.log(`[AutoReply] [FlowEngine] Leaf node reached. Clearing flow state.`);
        await context.storage.delete(stateKey);
      }
      return true;
    } else {
      // Invalid option selected
      console.log(`[AutoReply] [FlowEngine] Input did not match any options. Replying with fallback.`);
      const invalidMsg = `Invalid option. Please choose one of the available options:\n\n${currentNode.text}`;
      await context.messages.reply(sessionId, chatId, messageId, invalidMsg);
      
      // Update last active time to keep session alive
      state.lastActive = Date.now();
      await context.storage.set(stateKey, state);
      return true;
    }
  }
}
