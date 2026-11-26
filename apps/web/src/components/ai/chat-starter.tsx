'use client';

import { ChatComposer } from './chat-composer';
import { useChatStart } from './chat-start';

/**
 * The field on a workspace's start page that begins a chat (issue #288).
 *
 * Typing here and pressing Enter starts a new conversation about no page and
 * gives it the screen, which is what asking something quickly on a phone
 * needs. The field only hands the question over: the panel creates the
 * conversation and streams the answer (`chat-start.tsx`).
 */
export function ChatStarter({ workspaceId }: { workspaceId: string }) {
  const { start } = useChatStart();
  return (
    <div className="mb-10" data-testid="chat-starter">
      <ChatComposer
        variant="start"
        disabled={false}
        onSubmit={(text) => start({ workspaceId, text })}
      />
    </div>
  );
}
