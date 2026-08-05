import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type FastifyRequest } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';

import { AppError } from '../common/app-error';
import { setRequestUser } from '../common/correlation';

import { AuthService } from './auth.service';

export const IS_PUBLIC_ROUTE = 'exocortex:isPublicRoute';

/** Marks a route as reachable without a session (health checks, auth routes). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_ROUTE, true);

export interface AuthenticatedRequest extends FastifyRequest {
  exocortexSession?: VerifiedSession;
}

/**
 * Global guard: every route requires a valid session unless explicitly marked
 * `@Public()`. Authorization (workspace membership, roles) is a separate layer
 * handled by the policies in `@exocortex/auth`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.authService.verifySession(
      request.headers as Record<string, string | string[] | undefined>,
    );

    if (session === null) {
      throw AppError.unauthenticated('No valid session cookie was provided');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new AppError('session_expired', 'The session has expired');
    }

    request.exocortexSession = session;
    setRequestUser(session.userId);
    return true;
  }
}

/** Injects the verified session into a controller method. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedSession => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.exocortexSession === undefined) {
      throw AppError.unauthenticated('Route is not protected by SessionGuard');
    }
    return request.exocortexSession;
  },
);
