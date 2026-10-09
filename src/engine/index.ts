// Engine public surface for code outside src/engine: re-exported here so modules never reach into
// adapters/ internals. Intentionally narrow — add a symbol only when an outside consumer needs it.
export { BaileysStoredMessage } from './adapters/baileys-stored-message.entity';
export { inboundMediaConcurrency, inboundMediaMaxBytes, inboundMediaTimeoutMs } from './adapters/inbound-media-cap';
