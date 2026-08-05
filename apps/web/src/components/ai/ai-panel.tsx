'use client';

import { SendIcon, SparklesIcon } from 'lucide-react';
import * as React from 'react';

import { Badge, Button, cn,LoadingState, Textarea } from '@exocortex/ui';

import { useCreateAiRun } from '@/lib/api/queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

export interface AiPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

/**
 * AI side panel.
 *
 * The answer is produced by the mock provider in the worker process and streamed
 * to the browser through the application WebSocket, so the full streaming path
 * (worker -> Redis -> API -> socket -> UI) is exercised. No document content is
 * sent to any external service in this version.
 */
export function AiPanel({ workspaceId, documentId }: AiPanelProps) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const createRun = useCreateAiRun();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const appendDelta = React.useCallback((runId: string, delta: string) => {
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === runId);
      if (index === -1) {
        return [...current, { id: runId, role: 'assistant', content: delta, streaming: true }];
      }
      const next = [...current];
      const existing = next[index] as ChatMessage;
      next[index] = { ...existing, content: existing.content + delta };
      return next;
    });
  }, []);

  useRealtimeEvent('ai.run.progress', (event) => {
    if (event.payload.runId !== activeRunId) return;
    appendDelta(event.payload.runId, event.payload.delta);
  });

  useRealtimeEvent('ai.run.completed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setMessages((current) =>
      current.map((message) =>
        message.id === event.payload.runId
          ? { ...message, content: event.payload.text, streaming: false }
          : message,
      ),
    );
    setActiveRunId(null);
  });

  useRealtimeEvent('ai.run.failed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setError('Die KI-Antwort konnte nicht erzeugt werden.');
    setActiveRunId(null);
  });

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async (): Promise<void> => {
    const prompt = input.trim();
    if (prompt.length === 0 || workspaceId === null || activeRunId !== null) return;

    setError(null);
    setInput('');
    const userMessage: ChatMessage = {
      id: `user-${Date.now().toString(36)}`,
      role: 'user',
      content: prompt,
    };
    setMessages((current) => [...current, userMessage]);

    try {
      const response = await createRun.mutateAsync({
        workspaceId,
        documentId,
        messages: [
          ...messages.map((message) => ({ role: message.role, content: message.content })),
          { role: 'user' as const, content: prompt },
        ],
      });
      setActiveRunId(response.run.id);
    } catch {
      setError('Die Anfrage konnte nicht gestartet werden.');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-panel">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
            <SparklesIcon className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">KI-Assistenz</p>
            <p className="text-xs text-muted-foreground">
              Stelle eine Frage. In dieser Version antwortet ein lokaler Mock-Anbieter, damit keine
              Inhalte den Server verlassen.
            </p>
          </div>
        ) : null}

        {messages.map((message) => (
          <div
            key={message.id}
            data-testid={message.role === 'assistant' ? 'ai-answer' : 'ai-question'}
            className={cn(
              'rounded-md border px-3 py-2 text-sm whitespace-pre-wrap',
              message.role === 'user'
                ? 'border-border bg-muted'
                : 'border-primary/30 bg-card text-card-foreground',
            )}
          >
            {message.content}
            {message.streaming === true ? (
              <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-primary align-middle" />
            ) : null}
          </div>
        ))}

        {activeRunId !== null && messages.every((message) => message.role === 'user') ? (
          <LoadingState label="Antwort wird erzeugt …" />
        ) : null}

        {error !== null ? (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="border-t border-border p-2">
        {documentId !== null ? (
          <Badge variant="muted" className="mb-2">
            Kontext: aktuelle Seite
          </Badge>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            value={input}
            placeholder="Frage stellen …"
            data-testid="ai-input"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            className="min-h-[3.25rem] resize-none"
          />
          <Button
            size="icon"
            aria-label="Frage senden"
            data-testid="ai-send"
            disabled={activeRunId !== null || input.trim().length === 0}
            onClick={() => void send()}
          >
            <SendIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
