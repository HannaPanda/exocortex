'use client';

import * as React from 'react';

import { type ChatScrollMode } from '@exocortex/contracts';

import {
  lastQuestion,
  offsetWithin,
  paddingOf,
  prefersReducedMotion,
  useAnswerAnchor,
} from './use-answer-anchor';

export { QUESTION_ATTRIBUTE } from './use-answer-anchor';

/** How close to the bottom still counts as "at the end". */
const AT_END_PX = 32;

/** How long after a wheel, touch, key or scrollbar press a move up counts as the reader's. */
const READER_INPUT_MS = 1_000;

function distanceToEnd(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export interface TranscriptFollow {
  /** The transcript keeps the newest line in view; false once the reader scrolled up. */
  following: boolean;
  /** The question that starts the latest exchange lies above what is visible. */
  answerStartAbove: boolean;
  /** Nothing lies below what is visible. */
  atEnd: boolean;
  jumpToEnd: () => void;
  jumpToAnswerStart: () => void;
  /**
   * The reader sent a question that starts a run. Following, the transcript
   * goes to its end; staying at the answer's start, it brings this question
   * to the top once it is there.
   */
  sent: (questionId: string | null) => void;
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
 * With `mode: 'answerStart'` (issue #282) a sent question does not start
 * following: `useAnswerAnchor` brings it to the top once and holds it there,
 * and the answer grows downwards out of sight. Reaching the end follows
 * again, but only when the reader went there; the room under a short answer
 * ends where the view does, so the end is often reached without anybody
 * moving.
 *
 * `contentKey` changes whenever something in the transcript did; `resetKey`
 * names the conversation, and a new one starts at its end, following.
 */
export function useTranscriptFollow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  contentKey: string,
  resetKey: string | null,
  mode: ChatScrollMode,
): TranscriptFollow {
  const followingRef = React.useRef(true);
  const [following, setFollowingState] = React.useState(true);
  const [answerStartAbove, setAnswerStartAbove] = React.useState(false);
  const [atEnd, setAtEnd] = React.useState(true);
  const lastTopRef = React.useRef(0);
  const settledKeyRef = React.useRef<string | null | undefined>(undefined);
  const modeRef = React.useRef(mode);
  const anchor = useAnswerAnchor(scrollRef);

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
    setAtEnd(distanceToEnd(element) <= AT_END_PX);
  }, [scrollRef]);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    // When the reader last touched the transcript: wheel, touch, keys, or
    // the scrollbar (a press on the scrolling element itself).
    let touchedAt = Number.NEGATIVE_INFINITY;
    const touched = (): void => {
      touchedAt = Date.now();
      // Whoever moves the transcript decides where it stands from now on.
      anchor.release();
    };
    const pressed = (event: PointerEvent): void => {
      if (event.target === element) touched();
    };
    const onScroll = (): void => {
      const top = element.scrollTop;
      const movedUp = top < lastTopRef.current - 1;
      lastTopRef.current = top;
      const byReader = Date.now() - touchedAt < READER_INPUT_MS;
      anchor.scrolled(top);
      if (distanceToEnd(element) <= AT_END_PX) {
        if (!followingRef.current && (modeRef.current === 'follow' || byReader)) {
          setFollowing(true);
        }
      } else if (movedUp && followingRef.current && byReader) {
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
    // The panel grows when the run's activity line goes away at the end: an
    // anchored question has to stay where it is (issue #282).
    const resized = new ResizeObserver(() => {
      anchor.keep();
      measure();
    });
    resized.observe(element);
    return () => {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      resized.disconnect();
    };
  }, [scrollRef, setFollowing, measure, anchor]);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const fresh = settledKeyRef.current !== resetKey;
    if (fresh) {
      settledKeyRef.current = resetKey;
      anchor.clear();
      setFollowing(true);
    }
    if (anchor.tryAnchor()) {
      measure();
      return;
    }
    anchor.keep();
    if (fresh || followingRef.current) {
      const top = element.scrollHeight - element.clientHeight;
      if (top > element.scrollTop) {
        element.scrollTo({ top, behavior: fresh || prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    }
    measure();
  }, [scrollRef, contentKey, resetKey, setFollowing, measure, anchor]);

  // Switching back to following drops the anchor and the room under it.
  React.useLayoutEffect(() => {
    modeRef.current = mode;
    if (mode === 'follow') anchor.clear();
  }, [mode, anchor]);

  const jumpToEnd = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    anchor.release();
    setFollowing(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [scrollRef, setFollowing, anchor]);

  const jumpToAnswerStart = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const question = lastQuestion(element);
    if (question === null) return;
    anchor.release();
    setFollowing(false);
    // The transcript's own padding stays above the question.
    element.scrollTo({
      top: Math.max(0, offsetWithin(element, question) - paddingOf(element, 'paddingTop')),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [scrollRef, setFollowing, anchor]);

  const sent = React.useCallback(
    (questionId: string | null) => {
      if (modeRef.current === 'follow' || questionId === null) {
        jumpToEnd();
        return;
      }
      setFollowing(false);
      anchor.wait(questionId);
      if (anchor.tryAnchor()) measure();
    },
    [jumpToEnd, setFollowing, anchor, measure],
  );

  return { following, answerStartAbove, atEnd, jumpToEnd, jumpToAnswerStart, sent };
}
