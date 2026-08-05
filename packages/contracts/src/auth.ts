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

export const sessionUserSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const currentSessionResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
});
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;
