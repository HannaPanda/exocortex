/**
 * Renders every mail template with its example values, to look at (issue #109).
 *
 * Usage:
 *   pnpm --filter @exocortex/mail preview -- [--out <dir>] [--smtp <host:port>]
 *
 * Writes `<TEMPLATE>.html` and `<TEMPLATE>.txt` per template plus an
 * `index.html` linking them into `--out` (default `mail-preview/` in the
 * package, which git ignores). Open the index in a browser.
 *
 * `--smtp` additionally sends each one to that relay, for Mailpit
 * (`127.0.0.1:1026` with the compose file's defaults, UI on
 * http://127.0.0.1:8026). It deliberately takes a host and a port and no
 * credentials, and never reads `SMTP_*`: on a host whose `.env` points at the
 * production relay, a preview command must not be one flag away from posting
 * ten example mails to a real address.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createLogger } from '@exocortex/logger';

import { MAIL_EXAMPLES } from '../src/examples';
import { escapeHtml } from '../src/layout/compose';
import { renderMail } from '../src/render';
import { createMailTransport } from '../src/transport';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const out = resolve(argument('--out') ?? join(__dirname, '..', 'mail-preview'));
  const smtp = argument('--smtp');
  mkdirSync(out, { recursive: true });

  const logger = createLogger({ name: 'mail-preview', level: 'warn' });
  const transport =
    smtp === undefined
      ? null
      : createMailTransport({
          host: smtp.split(':')[0] ?? '127.0.0.1',
          port: Number(smtp.split(':')[1] ?? '1025'),
          from: 'eXocortex <vorschau@exocortex.invalid>',
          logger,
        });

  const rows: string[] = [];
  for (const message of Object.values(MAIL_EXAMPLES)) {
    const mail = renderMail(message);
    writeFileSync(join(out, `${message.template}.html`), mail.html);
    writeFileSync(join(out, `${message.template}.txt`), mail.text);
    rows.push(
      `<li><a href="${message.template}.html">${message.template}</a> · <a href="${message.template}.txt">Text</a> · ${escapeHtml(mail.subject)}</li>`,
    );
    if (transport !== null) {
      await transport.send({ to: 'vorschau@exocortex.invalid', message: mail });
    }
  }
  writeFileSync(
    join(out, 'index.html'),
    `<!DOCTYPE html><html lang="de"><meta charset="utf-8"><title>eXocortex: Mailvorschau</title><ul>${rows.join('')}</ul></html>\n`,
  );
  await transport?.close();

  process.stdout.write(`${String(rows.length)} Mails in ${out}\n`);
  if (smtp !== undefined) process.stdout.write(`und an ${smtp} geschickt\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
