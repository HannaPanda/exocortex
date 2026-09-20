import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

export const signUpRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  password: z.string().min(12).max(256),
});
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

export const signInRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/**
 * Global (cross-workspace) role. Lowercase on the wire like every other status
 * enum in this package (`aiRunStatusSchema`); the database's `UserRole` enum
 * is uppercase and mapped by the service layer.
 *
 * It lives beside the session rather than in `admin.ts`, because who somebody
 * is is an authentication answer; the administration screens are only its
 * loudest reader.
 */
export const userRoleSchema = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const sessionUserSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  /**
   * The deployment role, so the client can stop offering what it may not have.
   * Never authorization: every administrative route is guarded again in the API
   * (`AdminGuard`), and a browser that forges this field gains nothing but a
   * menu entry that answers with a refusal.
   */
  role: userRoleSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const currentSessionResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
});
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;
