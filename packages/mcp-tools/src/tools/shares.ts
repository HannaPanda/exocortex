import { z } from 'zod';

import {
  createShareRequestSchema,
  type DocumentShare,
  idSchema,
  incomingShareListResponseSchema,
  outgoingShareListResponseSchema,
  revokeShareResponseSchema,
  shareListResponseSchema,
  shareResponseSchema,
  updateShareRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Page shares and public links (issue #83, ADR-044).
 *
 * The thing the descriptions keep saying, because it is the thing a model gets
 * wrong: a share hands a page to somebody who is **not** in this workspace. It
 * is not a way to give a colleague access to the workspace, it is not
 * reversible for whoever has already read the page, and a public link puts the
 * page on the open internet for anybody who has the address. So the tools read
 * freely and write reluctantly, and creating a link is the one call here that
 * asks twice.
 */

function formatShare(share: DocumentShare): string {
  const who =
    share.kind === 'PUBLIC_LINK'
      ? `öffentlicher Link (${share.tokenPrefix ?? '?'}…)`
      : `${share.grantee?.name ?? 'unbekannt'} <${share.grantee?.email ?? '?'}>`;
  const reach = share.scope === 'SUBTREE' ? 'Seite und alles darunter' : 'nur diese Seite';
  const right = share.permission === 'WRITE' ? 'darf schreiben' : 'darf lesen';
  const until = share.expiresAt === null ? 'unbefristet' : `bis ${share.expiresAt}`;
  const state = share.revokedAt === null ? '' : ' — WIDERRUFEN';
  return `- ${who} · ${right} · ${reach} · ${until} (id: ${share.id})${state}`;
}

export const shareListTool: AnyToolDefinition = defineTool({
  name: 'exo_share_list',
  description:
    'Zeigt, wer eine Seite außerhalb des Arbeitsbereichs erreichen kann: Freigaben an einzelne ' +
    'Konten und öffentliche Links, widerrufene eingeschlossen. Der rohe Link steht hier nie, ' +
    'nur seine ersten Zeichen.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/shares`,
      responseSchema: shareListResponseSchema,
    });
    if (result.shares.length === 0 && result.inherited.length === 0) {
      return { text: 'Diese Seite ist nicht freigegeben.', data: result };
    }
    const own =
      result.shares.length === 0 ? [] : ['Auf dieser Seite:', ...result.shares.map(formatShare)];
    const above =
      result.inherited.length === 0
        ? []
        : [
            'Von weiter oben geerbt (jemand hat einen Bereich darüber freigegeben):',
            ...result.inherited.map(formatShare),
          ];
    return { text: [...own, ...above].join('\n'), data: result };
  },
});

export const shareInheritedTool: AnyToolDefinition = defineTool({
  name: 'exo_share_inherited',
  description:
    'Sagt, welche Freigaben eine Seite erben würde, die unter diese Seite verschoben oder dort ' +
    'angelegt wird. Vor jedem exo_page_move in einen fremden Bereich sinnvoll: eine Seite in ' +
    'einen freigegebenen Unterbaum zu schieben, gibt sie mit frei, ohne dass das nach Freigeben ' +
    'aussieht.',
  inputSchema: z.object({ parentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.parentId}/inherited-shares`,
      responseSchema: shareListResponseSchema,
    });
    if (result.inherited.length === 0) {
      return {
        text: 'Hier wird nichts geerbt: über dieser Seite liegt keine Freigabe für den Unterbaum.',
        data: result,
      };
    }
    return {
      text:
        'Achtung, alles unter dieser Seite ist damit mit freigegeben:\n' +
        result.inherited.map(formatShare).join('\n'),
      data: result,
    };
  },
});

export const shareWorkspaceListTool: AnyToolDefinition = defineTool({
  name: 'exo_share_workspace_list',
  description:
    'Listet alle Freigaben eines Arbeitsbereichs: was ist nach außen gegeben, an wen, mit ' +
    'welchem Recht und bis wann. Der Überblick, um aufzuräumen.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/shares`,
      responseSchema: outgoingShareListResponseSchema,
    });
    if (result.shares.length === 0) {
      return { text: 'In diesem Arbeitsbereich ist nichts freigegeben.', data: result };
    }
    const lines = result.shares.map(
      (share) =>
        `${share.documentTitle} (id: ${share.documentId})\n  ${formatShare(share).slice(2)}`,
    );
    return { text: lines.join('\n'), data: result };
  },
});

export const sharedWithMeTool: AnyToolDefinition = defineTool({
  name: 'exo_shared_with_me',
  description:
    'Listet Seiten, die andere mit diesem Konto geteilt haben, über alle Arbeitsbereiche ' +
    'hinweg. Diese Seiten tauchen in keinem Seitenbaum auf, weil das Konto dort kein Mitglied ' +
    'ist; nur diese Liste führt zu ihnen.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/me/shares',
      responseSchema: incomingShareListResponseSchema,
    });
    if (result.shares.length === 0) {
      return { text: 'Mit diesem Konto ist nichts geteilt.', data: result };
    }
    const lines = result.shares.map((share) => {
      const right = share.permission === 'WRITE' ? 'lesen und schreiben' : 'lesen';
      const reach = share.scope === 'SUBTREE' ? ' (mit allem darunter)' : '';
      return `- ${share.document.title} (id: ${share.document.id}) aus „${share.workspaceName}", von ${share.sharedByName}, ${right}${reach}`;
    });
    return { text: lines.join('\n'), data: result };
  },
});

export const shareCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_share_create',
  description:
    'Gibt eine Seite nach außen frei. kind USER teilt sie mit einem vorhandenen Konto (email ' +
    'nötig, permission READ oder WRITE); kind PUBLIC_LINK erzeugt eine Adresse, die jeder ' +
    'öffnen kann, der sie hat, und die immer nur lesend ist. scope PAGE_ONLY meint genau diese ' +
    'Seite, SUBTREE alles darunter. Der rohe Link kommt genau einmal zurück, in dieser Antwort, ' +
    'und ist danach nicht wieder abrufbar.',
  inputSchema: createShareRequestSchema.and(z.object({ documentId: idSchema })),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  // Not destructive: nothing that was there is taken away, and the share is
  // withdrawn with one call. But a public link is irreversible in the only
  // sense that matters here -- the address is out, and revoking it afterwards
  // does not unread the page. So this one spends the confirmation gate.
  irreversible: true,
  target: (input) => `Seite ${input.documentId}`,
  async preview(_client, input) {
    return input.kind === 'PUBLIC_LINK'
      ? `Das erzeugt eine öffentliche Adresse für diese Seite${input.scope === 'SUBTREE' ? ' und alle Seiten darunter' : ''}. Jeder, der sie hat, kann lesen, ohne Konto und ohne Anmeldung.`
      : `Das gibt ${input.email ?? 'dem genannten Konto'} ${input.permission === 'WRITE' ? 'Schreibzugriff' : 'Lesezugriff'} auf diese Seite${input.scope === 'SUBTREE' ? ' und alle Seiten darunter' : ''}.`;
  },
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/shares`,
      body,
      responseSchema: shareResponseSchema,
    });
    const link =
      result.share.token === null
        ? ''
        : `\nAdresse (nur jetzt sichtbar): /freigabe/${result.share.token}`;
    return { text: `Freigabe angelegt.\n${formatShare(result.share)}${link}`, data: result };
  },
});

export const shareUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_share_update',
  description:
    'Ändert eine bestehende Freigabe: permission (READ oder WRITE, bei einem öffentlichen Link ' +
    'nur READ), scope (PAGE_ONLY oder SUBTREE) und expiresInDays (null hebt die Befristung auf). ' +
    'Wer gerade auf der Seite sitzt, wird neu geprüft.',
  inputSchema: updateShareRequestSchema.extend({ shareId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `Freigabe ${input.shareId}`,
  async execute(client, input) {
    const { shareId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/shares/${shareId}`,
      body,
      responseSchema: shareResponseSchema,
    });
    return { text: `Freigabe geändert.\n${formatShare(result.share)}`, data: result };
  },
});

export const shareRevokeTool: AnyToolDefinition = defineTool({
  name: 'exo_share_revoke',
  description:
    'Widerruft eine Freigabe. Wirkt sofort, auch für offene Verbindungen; ein öffentlicher Link ' +
    'führt danach ins Leere. Was schon gelesen wurde, holt das nicht zurück.',
  inputSchema: z.object({ shareId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `Freigabe ${input.shareId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/shares/${input.shareId}`,
      responseSchema: revokeShareResponseSchema,
    });
    return { text: 'Freigabe widerrufen.', data: result };
  },
});

export const SHARE_TOOLS: readonly AnyToolDefinition[] = [
  shareListTool,
  shareInheritedTool,
  shareWorkspaceListTool,
  sharedWithMeTool,
  shareCreateTool,
  shareUpdateTool,
  shareRevokeTool,
];
