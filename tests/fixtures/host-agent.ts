import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
const sessionId = crypto.randomUUID();
acp.agent({ name: 'host-launch-fixture' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest('session/new', () => ({ sessionId }))
  .onRequest('session/load', () => ({}))
  .onRequest('session/prompt', () => ({ stopReason: 'end_turn' as const }))
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
