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

/**
 * Renaming a workspace and/or changing its slug.
 *
 * The two are deliberately independent: `slug` is never derived from `name`
 * here (unlike on creation, where `findFreeSlug()` derives it once). The slug
 * appears in URLs and in links people have already saved, so leaving it alone
 * on a plain rename is the safe default; changing it is an explicit, separate
 * choice the UI warns about.
 */
export const updateWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: workspaceSlugSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.slug !== undefined, {
    message: 'At least one field must be provided',
  });
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;
