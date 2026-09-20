import { All, Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';
import { type CurrentSessionResponse, currentSessionResponseSchema } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { openApiResponseSchema } from '../common/zod';
import { PRISMA } from '../platform/platform.module';

import { AuthService } from './auth.service';
import { CurrentSession, Public } from './session.guard';

/**
 * Mounts the Better Auth request handler.
 *
 * The controller is deliberately a pass-through: all authentication logic lives
 * in `@exocortex/auth`. Cookies are produced by Better Auth, so `Set-Cookie`
 * headers are copied verbatim.
 */
async function relay(
  authService: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const response = await authService.handleAuthRequest(request);

  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue;
    void reply.header(key, value);
  }
  // `getSetCookie` preserves multiple cookies, which a plain iteration merges.
  for (const cookie of response.headers.getSetCookie()) {
    void reply.header('set-cookie', cookie);
  }

  const body = await response.text();
  void reply.status(response.status).send(body.length > 0 ? body : undefined);
}

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @All('*')
  @ApiExcludeEndpoint()
  async handle(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await relay(this.authService, request, reply);
  }
}

/**
 * The OAuth discovery documents, at the origin root where a client looks.
 *
 * `@better-auth/mcp` serves the RFC 9728 protected-resource metadata from a
 * request hook that matches the *real* path, not a route under the auth base
 * path, so this is a pass-through rather than a rewrite: the request reaches
 * Better Auth with `/.well-known/...` intact and the hook answers it. Anything
 * else under `/.well-known` falls through to Better Auth's router and comes
 * back as a 404, which is the right answer for a document this server does not
 * publish.
 */
@ApiTags('auth')
@Controller('.well-known')
export class WellKnownController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @All('*')
  @ApiExcludeEndpoint()
  async handle(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await relay(this.authService, request, reply);
  }
}

@ApiTags('auth')
@Controller('api')
export class SessionController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Current session lookup used by the web client on every page load. */
  @Get('session')
  @ApiOkResponse({ schema: openApiResponseSchema(currentSessionResponseSchema) })
  async getSession(@CurrentSession() session: VerifiedSession): Promise<CurrentSessionResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        createdAt: true,
        role: true,
      },
    });
    if (user === null) {
      throw AppError.unauthenticated('Session references a user that no longer exists');
    }
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: user.createdAt.toISOString(),
        // Lowercase on the wire, like every other enum in the contracts
        // package. The client uses it to stop offering the administration area
        // to somebody who would only be refused there; the refusal itself is
        // still `AdminGuard`'s, on every single route.
        role: user.role === 'ADMIN' ? 'admin' : 'user',
      },
    };
  }
}
