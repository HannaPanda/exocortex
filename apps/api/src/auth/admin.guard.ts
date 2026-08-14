import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { canAdministerDeployment, WorkspaceAccessService } from '@exocortex/auth';

import { AppError } from '../common/app-error';

import { type AuthenticatedRequest } from './session.guard';

export const REQUIRES_ADMIN = 'exocortex:requiresAdmin';

/** Marks a route as reachable only by a global admin (`User.role === 'ADMIN'`). */
export const AdminOnly = (): MethodDecorator & ClassDecorator => SetMetadata(REQUIRES_ADMIN, true);

/**
 * Runs after `SessionGuard`, so `request.exocortexSession` is already set.
 * Routes without `@AdminOnly()` pass through unchanged.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly access: WorkspaceAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresAdmin = this.reflector.getAllAndOverride<boolean>(REQUIRES_ADMIN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiresAdmin !== true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = request.exocortexSession;
    if (session === undefined) {
      throw AppError.unauthenticated('Route is not protected by SessionGuard');
    }

    const role = await this.access.findGlobalRole(session.userId);
    const decision = canAdministerDeployment(role);
    if (!decision.allowed) {
      throw new AppError(decision.code, decision.reason);
    }

    return true;
  }
}
