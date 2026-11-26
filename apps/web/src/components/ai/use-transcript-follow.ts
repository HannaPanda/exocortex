'use client';

import * as React from 'react';

/** How close to the bottom still counts as "at the end". */
const AT_END_PX = 32;

/** How long after a wheel, touch, key or scrollbar press a move up counts as the reader's. */
const READER_INPUT_MS = 1_000;

/** Marks the question that starts the exchange "Zum Anfang der Antwort" jumps to. */
export const QUESTION_ATTRIBUTE = 'data-chat-question';

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function distanceToEnd(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function lastQuestion(element: HTMLElement): HTMLElement | null {
  const questions = element.querySelectorAll<HTMLElement>(`[${QUESTION_ATTRIBUTE}]`);
  return questions[questions.length - 1] ?? null;
}

/** Where `child` starts inside the scrolling `container`, in its scroll coordinates. */
function offsetWithin(container: HTMLElement, child: HTMLElement): number {
  return (
    child.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  );
}

export interface TranscriptFollow {
  /** The transcript keeps the newest line in view; false once the reader scrolled up. */
  following: boolean;
  /** The question that starts the latest exchange lies above what is visible. */
  answerStartAbove: boolean;
  jumpToEnd: () => void;
  jumpToAnswerStart: () => void;
  /** The reader sent something: whatever they were reading, they want to see it go. */
  follow: () => void;
}

/**
 * Whether the transcript follows what is arriving, and the two jumps that
 * get a reader back (issue #242).
 *
 * It follows until the reader scrolls up, and only the reader can stop it:
 * an answer that grows, a section that folds or a bubble swapped for its
 * stored copy never does, because a move up only counts right after the
 * reader touched the transcript. Reaching the end again, by hand or
 * with the button, resumes it. Following glides unless the person asked for
 * reduced motion, and the first position of a conversation is taken without
 * any movement at all, since there is nothing to follow yet.
 *
 * `contentKey` changes whenever something in the transcript did; `resetKey`
 * names the conversation, and a new one starts at its end, following.
 */
export function useTranscriptFollow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  contentKey: string,
  resetKey: string | null,
): TranscriptFollow {
  const followingRef = React.useRef(true);
  const [following, setFollowingState] = React.useState(true);
  const [answerStartAbove, setAnswerStartAbove] = React.useState(false);
  const lastTopRef = React.useRef(0);
  const settledKeyRef = React.useRef<string | null | undefined>(undefined);

  const setFollowing = React.useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowingState(value);
  }, []);

  const measure = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const question = lastQuestion(element);
    setAnswerStartAbove(
      question !== null && offsetWithin(element, question) < element.scrollTop - AT_END_PX,
    );
  }, [scrollRef]);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    // When the reader last touched the transcript: wheel, touch, keys, or
    // the scrollbar (a press on the scrolling element itself).
    let touchedAt = Number.NEGATIVE_INFINITY;
    const touched = (): void => {
      touchedAt = Date.now();
    };
    const pressed = (event: PointerEvent): void => {
      if (event.target === element) touched();
    };
    const onScroll = (): void => {
      const top = element.scrollTop;
      const movedUp = top < lastTopRef.current - 1;
      lastTopRef.current = top;
      if (distanceToEnd(element) <= AT_END_PX) {
        if (!followingRef.current) setFollowing(true);
      } else if (movedUp && followingRef.current && Date.now() - touchedAt < READER_INPUT_MS) {
        // Only the reader stops it. Content can move the position up as
        // well, when something above folds or the answer is swapped for its
        // stored copy, so a move up counts only right after the reader did
        // something. A glide that is still under way stops where they are.
        setFollowing(false);
        element.scrollTo({ top, behavior: 'auto' });
      }
      measure();
    };
    const listeners: [keyof HTMLElementEventMap, EventListener][] = [
      ['wheel', touched],
      ['touchmove', touched],
      ['keydown', touched],
      ['pointerdown', pressed as EventListener],
      ['scroll', onScroll],
    ];
    for (const [type, listener] of listeners) {
      element.addEventListener(type, listener, { passive: true });
    }
    return () => {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
    };
  }, [scrollRef, setFollowing, measure]);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const fresh = settledKeyRef.current !== resetKey;
    if (fresh) {
      settledKeyRef.current = resetKey;
      setFollowing(true);
    }
    if (fresh || followingRef.current) {
      const top = element.scrollHeight - element.clientHeight;
      if (top > element.scrollTop) {
        element.scrollTo({ top, behavior: fresh || prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    }
    measure();
  }, [scrollRef, contentKey, resetKey, setFollowing, measure]);

  const jumpToEnd = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    setFollowing(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [scrollRef, setFollowing]);

  const jumpToAnswerStart = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const question = lastQuestion(element);
    if (question === null) return;
    setFollowing(false);
    // The transcript's own padding stays above the question.
    const padding = Number.parseFloat(window.getComputedStyle(element).paddingTop) || 0;
    element.scrollTo({
      top: Math.max(0, offsetWithin(element, question) - padding),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [scrollRef, setFollowing]);

  return { following, answerStartAbove, jumpToEnd, jumpToAnswerStart, follow: jumpToEnd };
}
