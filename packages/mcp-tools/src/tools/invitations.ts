import { z } from 'zod';

import {
  adminUserListResponseSchema,
  adminUserSchema,
  deleteUserResponseSchema,
  idSchema,
  type Invitation,
  invitationListResponseSchema,
  invitationWithLinkSchema,
  revokeInvitationResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Invitations and account administration (issue #3).
 *
 * Registration is closed, so "add a person" is not something a human can do in
 * the UI and an agent cannot: the catalogue has to carry it, or the MCP surface
 * silently stops matching the application (CLAUDE.md rule 11, ADR-014).
 *
 * Every tool here needs an `admin`-scoped token, because the REST routes behind
 * them are under `/api/admin` (`requiredScopeForRequest`) -- except the workspace
 * invitation, which a workspace OWNER/ADMIN may issue with an ordinary `write`
 * token. That asymmetry is not this file's doing; it is the same authority split
 * the two REST routes have.
 */

function formatInvitation(invitation: Invitation): string {
  const destination =
    invitation.workspaceName === null
      ? 'ohne Arbeitsbereich'
      : `→ ${invitation.workspaceName} (${invitation.workspaceRole ?? 'MEMBER'})`;
  const delivery =
    invitation.lastSentAt === null
      ? 'Mail nicht angekommen'
      : `${invitation.sentCount}× verschickt`;
  return `${invitation.email} [${invitation.status}] ${destination}, von ${invitation.invitedByName}, ${delivery} (id: ${invitation.id})`;
}

export const invitationListTool: AnyToolDefinition = defineTool({
  name: 'exo_invitation_list',
  description:
    'Listet Einladungen. Ohne workspaceId alle Einladungen der Installation (braucht globale ' +
    'Administratorrechte), mit workspaceId nur die dieses Arbeitsbereichs (braucht dort OWNER ' +
    'oder ADMIN). Zeigt auch, ob die Einladungsmail rausging.',
  inputSchema: z.object({
    workspaceId: idSchema
      .optional()
      .describe('Nur Einladungen dieses Arbeitsbereichs. Weglassen listet die ganze Installation.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path:
        input.workspaceId === undefined
          ? '/api/admin/invitations'
          : `/api/workspaces/${input.workspaceId}/invitations`,
      responseSchema: invitationListResponseSchema,
    });
    if (result.invitations.length === 0) {
      return { text: 'Keine Einladungen.', data: result };
    }
    const text = result.invitations
      .map((invitation, index) => `${index + 1}. ${formatInvitation(invitation)}`)
      .join('\n');
    return { text, data: result };
  },
});

export const invitationCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_invitation_create',
  description:
    'Lädt eine E-Mail-Adresse ein und verschickt die Einladungsmail. Registrieren ohne Einladung ' +
    'ist abgeschaltet, das hier ist der einzige Weg zu einem neuen Konto. Mit workspaceId wird die ' +
    'Person zugleich Mitglied dieses Arbeitsbereichs; ohne bekommt sie ein Konto, das noch nichts ' +
    'sieht. Der zurückgegebene Link ist nur in dieser Antwort enthalten und wird nirgends ' +
    'gespeichert: weitergeben, wenn emailSent false ist.',
  inputSchema: z.object({
    email: z.email().describe('Adresse, an die die Einladung geht'),
    workspaceId: idSchema
      .optional()
      .describe(
        'Arbeitsbereich, in dem die Person Mitglied wird. Weglassen lädt nur die Installation.',
      ),
    workspaceRole: z
      .enum(['ADMIN', 'MEMBER', 'GUEST'])
      .default('MEMBER')
      .describe(
        'Rolle im Arbeitsbereich. OWNER gibt es hier nicht, Besitz wird bewusst übergeben.',
      ),
    role: z
      .enum(['user', 'admin'])
      .default('user')
      .describe('Globale Rolle des neuen Kontos. admin nur mit globalen Administratorrechten.'),
    expiresInDays: z.number().int().min(1).max(90).default(7).describe('Gültigkeit in Tagen'),
    /**
     * Which of the two REST routes to use. Explicit rather than inferred from
     * `workspaceId`, because the two differ in what they are allowed to grant and
     * in which credential they need -- guessing would mean an agent with a
     * workspace-scoped credential silently hitting the admin route and getting a
     * 403 it cannot interpret.
     */
    via: z
      .enum(['admin', 'workspace'])
      .default('admin')
      .describe(
        'admin nutzt die Installations-Route (globale Administratorrechte), workspace die des ' +
          'Arbeitsbereichs (dort OWNER oder ADMIN). workspace braucht workspaceId.',
      ),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  target: (input) => `invitation:${input.email}`,
  async execute(client, input) {
    if (input.via === 'workspace' && input.workspaceId === undefined) {
      return { text: 'via: "workspace" braucht eine workspaceId.', isError: true };
    }

    const body = {
      email: input.email,
      workspaceRole: input.workspaceRole,
      role: input.role,
      expiresInDays: input.expiresInDays,
      // The workspace route takes it from the path; repeating it in the body
      // would be ignored there.
      ...(input.via === 'admin' && input.workspaceId !== undefined
        ? { workspaceId: input.workspaceId }
        : {}),
    };

    const result = await client.request({
      method: 'POST',
      path:
        input.via === 'admin'
          ? '/api/admin/invitations'
          : `/api/workspaces/${input.workspaceId as string}/invitations`,
      body,
      responseSchema: invitationWithLinkSchema,
    });

    const delivery = result.emailSent
      ? 'Einladungsmail verschickt.'
      : 'Die Einladungsmail ließ sich NICHT verschicken. Gib den Link direkt weiter.';
    return {
      text: `${formatInvitation(result.invitation)}\n${delivery}\nLink: ${result.url}`,
      data: result,
    };
  },
});

export const invitationResendTool: AnyToolDefinition = defineTool({
  name: 'exo_invitation_resend',
  description:
    'Verschickt eine Einladung erneut, mit einem neuen Link. Der alte Link gilt danach nicht mehr. ' +
    'Zieht eine zurückgezogene Einladung damit auch wieder hervor.',
  inputSchema: z.object({
    invitationId: idSchema,
    workspaceId: idSchema
      .optional()
      .describe('Über die Arbeitsbereichs-Route gehen statt über die der Installation.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  // The previous link stops working, so something a person may already be
  // holding is taken away.
  destructive: true,
  target: (input) => `invitation:${input.invitationId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path:
        input.workspaceId === undefined
          ? `/api/admin/invitations/${input.invitationId}/resend`
          : `/api/workspaces/${input.workspaceId}/invitations/${input.invitationId}/resend`,
      responseSchema: invitationWithLinkSchema,
    });
    const delivery = result.emailSent
      ? 'Erneut verschickt.'
      : 'Erneut angelegt, aber die Mail ging nicht raus. Link direkt weitergeben.';
    return { text: `${delivery}\nLink: ${result.url}`, data: result };
  },
});

export const invitationRevokeTool: AnyToolDefinition = defineTool({
  name: 'exo_invitation_revoke',
  description:
    'Zieht eine Einladung zurück. Der Link funktioniert sofort nicht mehr. Eine bereits ' +
    'eingelöste Einladung lässt sich nicht zurückziehen, dafür deaktiviert man das Konto.',
  inputSchema: z.object({
    invitationId: idSchema,
    workspaceId: idSchema
      .optional()
      .describe('Über die Arbeitsbereichs-Route gehen statt über die der Installation.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  destructive: true,
  target: (input) => `invitation:${input.invitationId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path:
        input.workspaceId === undefined
          ? `/api/admin/invitations/${input.invitationId}`
          : `/api/workspaces/${input.workspaceId}/invitations/${input.invitationId}`,
      responseSchema: revokeInvitationResponseSchema,
    });
    return { text: 'Einladung zurückgezogen.', data: result };
  },
});

export const userListTool: AnyToolDefinition = defineTool({
  name: 'exo_user_list',
  description:
    'Listet die Konten dieser Installation mit globaler Rolle, Anzahl Arbeitsbereiche und ob das ' +
    'Konto deaktiviert ist. Braucht globale Administratorrechte.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/admin/users',
      responseSchema: adminUserListResponseSchema,
    });
    const text = result.users
      .map((user, index) => {
        const state = user.disabledAt === null ? 'aktiv' : 'deaktiviert';
        return `${index + 1}. ${user.name} <${user.email}> [${user.role}, ${state}] ${user.workspaceCount} Arbeitsbereiche (id: ${user.id})`;
      })
      .join('\n');
    return { text, data: result };
  },
});

export const userSetDisabledTool: AnyToolDefinition = defineTool({
  name: 'exo_user_set_disabled',
  description:
    'Schaltet ein Konto ab oder wieder an. Beim Abschalten werden alle Sitzungen beendet und alle ' +
    'API-Tokens dieses Kontos widerrufen; die Inhalte bleiben. Das eigene Konto und der letzte ' +
    'Administrator lassen sich nicht abschalten. Braucht globale Administratorrechte.',
  inputSchema: z.object({
    userId: idSchema,
    disabled: z.boolean().describe('true schaltet ab, false wieder an'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  // Switching somebody off takes access away from a person; that is exactly the
  // kind of call a client should be able to put behind a confirmation.
  destructive: true,
  target: (input) => `user:${input.userId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: `/api/admin/users/${input.userId}/status`,
      body: { disabled: input.disabled },
      responseSchema: adminUserSchema,
    });
    return {
      text: `${result.email} ist jetzt ${result.disabledAt === null ? 'aktiv' : 'deaktiviert'}.`,
      data: result,
    };
  },
});

export const userDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_user_delete',
  description:
    'Löscht ein Konto endgültig. Geht nur, solange das Konto nichts angelegt hat (keine Seiten, ' +
    'Kommentare oder Dateien) -- sonst antwortet die API user_has_content, und dann ist ' +
    'exo_user_set_disabled der richtige Weg. Gedacht für die Einladung an die falsche Adresse. ' +
    'Braucht globale Administratorrechte.',
  inputSchema: z.object({ userId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `user:${input.userId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/admin/users/${input.userId}`,
      responseSchema: deleteUserResponseSchema,
    });
    return { text: 'Konto gelöscht.', data: result };
  },
});

export const INVITATION_TOOLS: readonly AnyToolDefinition[] = [
  invitationListTool,
  invitationCreateTool,
  invitationResendTool,
  invitationRevokeTool,
  userListTool,
  userSetDisabledTool,
  userDeleteTool,
];
