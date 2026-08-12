/**
 * The copy-and-paste lines that connect an agent to this deployment.
 *
 * They live here rather than inside the cards because two places need the exact
 * same text: the setup section, where the token is a placeholder, and the dialog
 * that shows a freshly created token, where the real secret is already inside
 * the command. That second case is the whole point -- a token is shown once, so
 * anything a person has to paste into it by hand is a step where setup fails.
 */

/** Stands in for a token nobody has minted yet. Deliberately German and obviously fake. */
export const TOKEN_PLACEHOLDER = 'DEIN_TOKEN';

export interface ConnectionSnippet {
  id: string;
  /** The client this is for, as its makers spell it. */
  title: string;
  /** One line on what this connects, in German. */
  summary: string;
  /** What to copy. Empty lines are preserved; the copy button copies it verbatim. */
  code: string;
  /** Shell, JSON or YAML -- only used to label the block. */
  language: 'bash' | 'json' | 'yaml' | 'text';
  /** Anything that cannot be expressed as part of the command. */
  notes: string[];
  /** False when this client authenticates with OAuth and needs no token at all. */
  usesToken: boolean;
}

/**
 * `origin` is where the browser currently is, which is also where the API is:
 * the web app and the API share an origin (`apiRequest` is same-origin), so the
 * URL a person sees in the address bar is the URL their agent needs. Deriving it
 * this way keeps a self-hosted deployment correct without a build-time variable.
 */
export function connectionSnippets(origin: string, token: string | null): ConnectionSnippet[] {
  const secret = token ?? TOKEN_PLACEHOLDER;
  const mcpUrl = `${origin}/api/mcp`;
  const researchUrl = `${origin}/api/mcp/research`;

  return [
    {
      id: 'claude-code',
      title: 'Claude Code',
      summary: 'Fügt eXocortex als MCP-Server über HTTP hinzu. Eine Zeile im Terminal.',
      code: `claude mcp add --transport http exocortex ${mcpUrl} --header "Authorization: Bearer ${secret}"`,
      language: 'bash',
      notes: [
        'Ohne weitere Angabe gilt der Server nur im aktuellen Projekt. Mit --scope user am Ende steht er in allen Projekten zur Verfügung.',
        'Prüfen mit: claude mcp list',
      ],
      usesToken: true,
    },
    {
      id: 'chatgpt',
      title: 'ChatGPT',
      summary:
        'Als Connector anlegen und OAuth wählen. ChatGPT kann kein Token entgegennehmen, es meldet sich stattdessen bei dir an.',
      code: mcpUrl,
      language: 'text',
      notes: [
        `Für Deep Research die eigene URL nehmen: ${researchUrl}. Sie kennt nur "search" und "fetch" und kann nichts verändern.`,
        'Nach dem Anlegen landest du auf der Zustimmungsseite. Erst dein „Verbinden“ dort gibt ChatGPT Zugriff, und der Abschnitt „Verbundene Anwendungen“ oben nimmt ihn wieder weg.',
        'Ein Token brauchst du hier nicht. Wenn ein Connector nach einem fragt, ist es nicht dieser hier.',
      ],
      usesToken: false,
    },
    {
      id: 'hermes',
      title: 'Hermes',
      summary: 'Startet den MCP-Server als Prozess. Gehört in ~/.hermes/config.yaml.',
      code: `mcp_servers:
  exocortex:
    command: node
    args: ['/var/www/exocortex/apps/mcp/dist/main.js']
    env:
      EXOCORTEX_API_URL: '${origin}'
      EXOCORTEX_API_TOKEN: '${secret}'`,
      language: 'yaml',
      notes: [
        'Läuft Hermes auf demselben Rechner wie eXocortex, ist http://127.0.0.1:3211 die bessere API-URL: der Weg geht dann direkt an die API, ohne nginx.',
        'Der Pfad in args zeigt auf die gebaute Datei von apps/mcp auf diesem Rechner.',
      ],
      usesToken: true,
    },
    {
      id: 'other-http',
      title: 'Anderer Client über HTTP',
      summary: 'Jeder Client, der Streamable HTTP spricht, braucht nur URL und Token.',
      code: `URL:    ${mcpUrl}
Header: Authorization: Bearer ${secret}`,
      language: 'text',
      notes: [
        'Zum Ausprobieren, ob Token und URL stimmen:',
        `curl -sS ${mcpUrl} -H 'authorization: Bearer ${secret}' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ],
      usesToken: true,
    },
  ];
}
