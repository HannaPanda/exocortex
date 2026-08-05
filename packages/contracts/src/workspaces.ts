import { z } from 'zod';

import { idSchema, isoDateTimeSchema, workspaceRoleSchema } from './primitives';

export const workspaceSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case');

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: workspaceSlugSchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** Role of the requesting user inside this workspace. */
  role: workspaceRoleSchema,
  memberCount: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const workspaceMemberSchema = z.object({
  id: idSchema,
  userId: idSchema,
  name: z.string(),
  email: z.string(),
  role: workspaceRoleSchema,
  createdAt: isoDateTimeSchema,
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const workspaceDetailSchema = workspaceSchema.extend({
  members: z.array(workspaceMemberSchema),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const updateWorkspaceMemberRequestSchema = z.object({
  role: workspaceRoleSchema,
});
export type UpdateWorkspaceMemberRequest = z.infer<typeof updateWorkspaceMemberRequestSchema>;
