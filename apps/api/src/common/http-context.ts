import { type ExecutionContext } from '@nestjs/common';

/**
 * Whether this call arrived over HTTP, as opposed to a WebSocket message.
 *
 * The four global guards in `app.module.ts` are written for requests: they read
 * headers, set rate-limit headers and attach a verified session to the request
 * object. Up to NestJS 11 that was all they ever saw. NestJS 12 runs global
 * guards on `@SubscribeMessage` handlers too, where `switchToHttp().getRequest()`
 * hands back the Socket.IO socket and `getResponse()` the message payload --
 * so `ThrottlerGuard` called `res.header(...)` on a socket and every realtime
 * message died with `res.header is not a function`.
 *
 * A socket is not unguarded because of this. `RealtimeGateway` authenticates
 * the handshake and every handler awaits `data.authenticated` before it does
 * anything, which is where socket authorization belongs (ADR-008).
 */
export function isHttpContext(context: ExecutionContext): boolean {
  return context.getType() === 'http';
}
