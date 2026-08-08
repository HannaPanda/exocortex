import { spawn } from 'node:child_process';

import { type Logger } from '@exocortex/logger';

/**
 * How a reminder leaves the deployment.
 *
 * An interface with one method, because the delivery channel is not this system's
 * business. Exocortex knows an appointment is due; who gets told, and over which
 * messenger, is somebody else's configuration. On this host that somebody is
 * Hermes, whose one-shot sender reaches Telegram with the gateway's own
 * credentials and without starting an LLM.
 */
export interface ReminderNotifier {
  /** Rejects when the message was not delivered, so the caller can retry later. */
  send(body: string): Promise<void>;
}

export interface CommandNotifierOptions {
  /** Absolute path to the executable. */
  command: string;
  /** Delivery target, handed to the command as `--to`. */
  target: string;
  logger: Logger;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A notifier that hands the message to an external sender.
 *
 * The body travels on **stdin**, never as an argument. Two reasons, and the second
 * one is the real one: an argument list has a length limit, and a message that
 * happens to begin with a dash would be read as an option. `--file -` is the
 * sender's documented way to say "the text is coming on stdin".
 *
 * Spawned without a shell, so nothing in the message is ever interpreted.
 *
 * CLAUDE.md rule 6 (never execute a CLI from the API, the web server or the
 * collaboration server) is why this lives in the worker and nowhere else.
 */
export function createCommandNotifier(options: CommandNotifierOptions): ReminderNotifier {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(body: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          options.command,
          ['send', '--to', options.target, '--quiet', '--file', '-'],
          { stdio: ['pipe', 'ignore', 'pipe'] },
        );

        // Bounded, because a sender that decides to be chatty on stderr must not
        // grow the worker's memory. The tail is what carries the error anyway.
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Reminder command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`Reminder command exited with ${code}: ${stderr.trim().slice(0, 300)}`));
        });

        child.stdin.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stdin.end(body, 'utf8');
      });
    },
  };
}
