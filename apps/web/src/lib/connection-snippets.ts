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

/** The clients this page has a setup card for, in the order they are shown. */
export type ConnectionSnippetId =
  'claude-code-plugin' | 'claude-code' | 'chatgpt' | 'hermes' | 'other-http';

/**
 * The prose notes a card can carry. Their wording lives in the `account.setup`
 * catalogue under `notes.<key>`; this module only decides which note belongs
 * where and which values go into it, so it never returns a sentence itself.
 */
export type ConnectionNoteKey =
  | 'pluginInSession'
  | 'pluginAsksForToken'
  | 'pluginVerify'
  | 'claudeCodeScope'
  | 'claudeCodeVerify'
  | 'chatgptResearch'
  | 'chatgptConsent'
  | 'chatgptNoToken'
  | 'hermesLocalApi'
  | 'hermesPath'
  | 'httpTry';

/** A note is either a sentence from the catalogue or a line of code shown verbatim. */
export type ConnectionNote =
  | { kind: 'text'; key: ConnectionNoteKey; values?: Record<string, string> }
  | { kind: 'code'; code: string };

export interface ConnectionSnippet {
  /** Also the catalogue key of the card's title and summary (`account.setup.snippets.<id>`). */
  id: ConnectionSnippetId;
  /** What to copy. Empty lines are preserved; the copy button copies it verbatim. */
  code: string;
  /** Shell, JSON or YAML -- only used to label the block. */
  language: 'bash' | 'json' | 'yaml' | 'text';
  /** Anything that cannot be expressed as part of the command. */
  notes: ConnectionNote[];
  /** False when this client authenticates with OAuth and needs no token at all. */
  usesToken: boolean;
}

const note = (key: ConnectionNoteKey, values?: Record<string, string>): ConnectionNote =>
  values === undefined ? { kind: 'text', key } : { kind: 'text', key, values };

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
      id: 'claude-code-plugin',
      code: `/plugin marketplace add HannaPanda/exocortex
/plugin install exocortex@exocortex`,
      language: 'text',
      notes: [note('pluginInSession'), note('pluginAsksForToken'), note('pluginVerify')],
      usesToken: false,
    },
    {
      id: 'claude-code',
      code: `claude mcp add --transport http exocortex ${mcpUrl} --header "Authorization: Bearer ${secret}"`,
      language: 'bash',
      notes: [note('claudeCodeScope'), note('claudeCodeVerify')],
      usesToken: true,
    },
    {
      id: 'chatgpt',
      code: mcpUrl,
      language: 'text',
      notes: [
        note('chatgptResearch', { url: researchUrl }),
        note('chatgptConsent'),
        note('chatgptNoToken'),
      ],
      usesToken: false,
    },
    {
      id: 'hermes',
      code: `mcp_servers:
  exocortex:
    command: node
    args: ['/var/www/exocortex/apps/mcp/dist/main.js']
    env:
      EXOCORTEX_API_URL: '${origin}'
      EXOCORTEX_API_TOKEN: '${secret}'`,
      language: 'yaml',
      notes: [note('hermesLocalApi', { url: 'http://127.0.0.1:3211' }), note('hermesPath')],
      usesToken: true,
    },
    {
      id: 'other-http',
      code: `URL:    ${mcpUrl}
Header: Authorization: Bearer ${secret}`,
      language: 'text',
      notes: [
        note('httpTry'),
        {
          kind: 'code',
          code: `curl -sS ${mcpUrl} -H 'authorization: Bearer ${secret}' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        },
      ],
      usesToken: true,
    },
  ];
}
