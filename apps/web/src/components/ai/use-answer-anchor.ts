'use client';

import * as React from 'react';

import { anchorTop, spacerHeight } from './transcript-anchor';

/**
 * Marks a question; "Zum Anfang der Antwort" jumps to the last one, and
 * "Am Antwortanfang bleiben" finds the one just sent by its value, the
 * message id.
 */
export const QUESTION_ATTRIBUTE = 'data-chat-question';

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function lastQuestion(element: HTMLElement): HTMLElement | null {
  const questions = element.querySelectorAll<HTMLElement>(`[${QUESTION_ATTRIBUTE}]`);
  return questions[questions.length - 1] ?? null;
}

function questionById(element: HTMLElement, id: string): HTMLElement | null {
  return element.querySelector<HTMLElement>(`[${QUESTION_ATTRIBUTE}="${CSS.escape(id)}"]`);
}

/** Where `child` starts inside the scrolling `container`, in its scroll coordinates. */
export function offsetWithin(container: HTMLElement, child: HTMLElement): number {
  return (
    child.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  );
}

export function paddingOf(element: HTMLElement, side: 'paddingTop' | 'paddingBottom'): number {
  return Number.parseFloat(window.getComputedStyle(element)[side]) || 0;
}

interface AnchorState {
  /** The question sent and not in the transcript yet. */
  pending: string | null;
  /** The question the transcript was brought to. */
  questionId: string | null;
  /**
   * Where the question is held until the reader moves the transcript;
   * `arrived` once the glide there is over, so holding never cuts it short.
   */
  hold: { top: number; arrived: boolean } | null;
  /** The room made under the answer, in pixels, and the padding it sits on. */
  room: number;
  basePadding: number;
}

const EMPTY: AnchorState = { pending: null, questionId: null, hold: null, room: 0, basePadding: 0 };

export interface AnswerAnchor {
  /** A question was sent: bring it to the top once it is in the transcript. */
  wait: (questionId: string) => void;
  /** Anchors the awaited question if it is there by now; true when it did. */
  tryAnchor: () => boolean;
  /** Fits the room under the answer and keeps the question where it was put. */
  keep: () => void;
  /** The reader moved the transcript: from now on it stands where they put it. */
  release: () => void;
  /** The transcript scrolled to `top`, by whatever reason. */
  scrolled: (top: number) => void;
  /** No anchor any more, and no room under the answer. */
  clear: () => void;
}

/**
 * "Am Antwortanfang bleiben" (issue #282): bring a sent question to the top
 * of the transcript once, then leave the view alone.
 *
 * At the start the answer is a line long and there is nothing below the
 * question to scroll into, so room is made under the answer (as padding on
 * the transcript, so nothing inside it changes place) and shrinks as the
 * answer fills it. The question is held at the top against what the browser
 * would do on its own (the panel growing when the run's activity line goes,
 * the trace folding at the run's end) until the reader moves the transcript.
 */
export function useAnswerAnchor(scrollRef: React.RefObject<HTMLDivElement | null>): AnswerAnchor {
  const state = React.useRef<AnchorState>(EMPTY);

  const setRoom = React.useCallback(
    (room: number) => {
      const element = scrollRef.current;
      const current = state.current;
      if (element === null || room === current.room) return;
      // On top of the transcript's own padding, which its class sets and
      // which is read while no room has been added to it.
      const basePadding =
        current.room === 0 ? paddingOf(element, 'paddingBottom') : current.basePadding;
      state.current = { ...current, room, basePadding };
      element.style.paddingBottom = room > 0 ? `${String(basePadding + room)}px` : '';
    },
    [scrollRef],
  );

  /** The position that shows the anchored question at the top, with room made for it. */
  const fitRoom = React.useCallback((): number | null => {
    const element = scrollRef.current;
    const questionId = state.current.questionId;
    if (element === null) return null;
    if (questionId === null) {
      setRoom(0);
      return null;
    }
    const question = questionById(element, questionId);
    if (question === null) return null;
    const top = offsetWithin(element, question);
    const target = anchorTop(
      { top, bottom: top + question.getBoundingClientRect().height },
      paddingOf(element, 'paddingTop'),
      element.clientHeight,
    );
    setRoom(
      spacerHeight({
        target,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        spacer: state.current.room,
      }),
    );
    return target;
  }, [scrollRef, setRoom]);

  const keep = React.useCallback(() => {
    const element = scrollRef.current;
    const target = fitRoom();
    const hold = state.current.hold;
    if (element === null || target === null || hold === null) return;
    state.current = { ...state.current, hold: { ...hold, top: target } };
    if (hold.arrived && Math.abs(element.scrollTop - target) > 1) {
      element.scrollTo({ top: target, behavior: 'auto' });
    }
  }, [scrollRef, fitRoom]);

  const tryAnchor = React.useCallback((): boolean => {
    const element = scrollRef.current;
    const questionId = state.current.pending;
    if (element === null || questionId === null) return false;
    if (questionById(element, questionId) === null) return false;
    state.current = { ...state.current, pending: null, questionId, hold: null };
    const target = fitRoom();
    if (target === null) return false;
    const instant = prefersReducedMotion();
    state.current = { ...state.current, hold: { top: target, arrived: instant } };
    element.scrollTo({ top: target, behavior: instant ? 'auto' : 'smooth' });
    return true;
  }, [scrollRef, fitRoom]);

  const wait = React.useCallback((questionId: string) => {
    state.current = { ...state.current, pending: questionId, hold: null };
  }, []);

  const release = React.useCallback(() => {
    if (state.current.hold !== null) state.current = { ...state.current, hold: null };
  }, []);

  const scrolled = React.useCallback((top: number) => {
    const hold = state.current.hold;
    if (hold !== null && !hold.arrived && Math.abs(top - hold.top) <= 1) {
      state.current = { ...state.current, hold: { ...hold, arrived: true } };
    }
  }, []);

  const clear = React.useCallback(() => {
    state.current = { ...state.current, pending: null, questionId: null, hold: null };
    setRoom(0);
  }, [setRoom]);

  return React.useMemo(
    () => ({ wait, tryAnchor, keep, release, scrolled, clear }),
    [wait, tryAnchor, keep, release, scrolled, clear],
  );
}
