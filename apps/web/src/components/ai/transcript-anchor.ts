/**
 * Where "Am Antwortanfang bleiben" puts the transcript, as arithmetic on
 * measured numbers (issue #282). Kept free of the DOM so the rules can be
 * tested without a browser.
 *
 * All positions are in the scroller's own scroll coordinates: 0 is the top
 * of its content, not of the screen.
 */

/** How much of the visible height the answer below a long question keeps at least. */
const ANSWER_SHARE = 2 / 3;

export interface QuestionBox {
  /** Where the question starts. */
  top: number;
  /** Where it ends. */
  bottom: number;
}

/**
 * The scroll position that shows the question at the top of the transcript,
 * below the transcript's own padding.
 *
 * A question taller than a third of the view would push the beginning of the
 * answer out of sight, and the answer's beginning is what this mode is for:
 * then the question's end stands a third of the way down instead, and its
 * start lies above.
 */
export function anchorTop(question: QuestionBox, paddingTop: number, clientHeight: number): number {
  const questionAtTop = question.top - paddingTop;
  const answerKeepsItsShare = question.bottom - clientHeight * (1 - ANSWER_SHARE);
  return Math.max(0, questionAtTop, answerKeepsItsShare);
}

/**
 * How tall the empty space under the answer has to be, so that the
 * transcript can be scrolled down to `target` at all.
 *
 * At the start the answer is a line long and there is nothing below the
 * question to scroll into; without room underneath, the browser would hold
 * the question at the bottom. The room shrinks as the answer grows and is
 * gone once the answer fills the view, so it never leaves an empty screen
 * to scroll into below a long answer.
 *
 * `scrollHeight` is measured with the current `spacer` inside it.
 */
export function spacerHeight(input: {
  target: number;
  scrollHeight: number;
  clientHeight: number;
  spacer: number;
}): number {
  const reachable = input.scrollHeight - input.clientHeight;
  return Math.max(0, Math.ceil(input.spacer + input.target - reachable));
}
