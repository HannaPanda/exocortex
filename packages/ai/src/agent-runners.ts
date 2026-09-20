import { type AiUsage } from '@exocortex/contracts';

/**
 * Contracts for CLI-based coding agents (Claude Code, Codex CLI).
 *
 * Neither runner is implemented in this version. The contracts exist so the
 * execution boundary is fixed now: a runner is always invoked from an isolated
 * worker process or container, never from the API, the Next.js server or the
 * collaboration server (see docs/ai-architecture.md).
 */

export type AgentRunnerId = 'claude-code' | 'codex-cli';

export interface AgentRunRequest {
  runId: string;
  workspaceId: string;
  userId: string;
  /** Natural-language instruction for the agent. */
  instruction: string;
  /**
   * Working directory inside the sandbox. Runners must reject any path outside
   * their sandbox root.
   */
  workingDirectory: string;
  /** Files the agent is allowed to read, relative to `workingDirectory`. */
  allowedPaths?: readonly string[];
  timeoutMs: number;
  budgetMicroUsd: number;
  correlationId: string;
  signal?: AbortSignal;
}

export type AgentRunEvent =
  | { type: 'started'; runner: AgentRunnerId; sandboxId: string }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'tool_call'; name: string; summary: string }
  | { type: 'file_changed'; path: string; changeType: 'created' | 'modified' | 'deleted' }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'finished'; exitCode: number }
  | { type: 'failed'; code: string; message: string };

export interface AgentRunnerCapabilities {
  /** Runner can modify files in its sandbox. */
  fileWrites: boolean;
  /** Runner can execute shell commands. */
  shellExecution: boolean;
  /** Runner can reach the network from inside the sandbox. */
  networkAccess: boolean;
  /** Isolation mechanism the implementation guarantees. */
  isolation: 'container' | 'separate-process' | 'none';
}

export interface AgentRunner {
  readonly id: AgentRunnerId;
  readonly capabilities: AgentRunnerCapabilities;
  /**
   * Runs the agent inside an isolated environment. Implementations must reject
   * being called from a process that also serves HTTP or WebSocket traffic.
   */
  run(request: AgentRunRequest): AsyncIterable<AgentRunEvent>;
  cancel(runId: string): Promise<void>;
}

export class AgentRunnerNotImplementedError extends Error {
  public readonly code = 'agent_runner_not_implemented';

  constructor(runner: AgentRunnerId) {
    super(
      `Agent runner "${runner}" is not implemented yet. It must run inside an ` +
        `isolated worker or container; see docs/ai-architecture.md.`,
    );
    this.name = 'AgentRunnerNotImplementedError';
  }
}

/**
 * Placeholder runner used by the AI queue's documented placeholder processor. It
 * fails loudly instead of pretending to work.
 */
export function createUnimplementedRunner(id: AgentRunnerId): AgentRunner {
  return {
    id,
    capabilities: {
      fileWrites: false,
      shellExecution: false,
      networkAccess: false,
      isolation: 'none',
    },
    // oxlint-disable-next-line require-yield
    async *run(): AsyncIterable<AgentRunEvent> {
      throw new AgentRunnerNotImplementedError(id);
    },
    async cancel(): Promise<void> {
      throw new AgentRunnerNotImplementedError(id);
    },
  };
}
