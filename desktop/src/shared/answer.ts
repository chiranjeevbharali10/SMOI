import type { AnswerResult, Passage, SourceRef, StreamEvent } from './apiTypes';

/**
 * What the chat shows for one question, built from the stream's events. The rules keep the
 * display honest:
 *
 * - Text streams in before its citations are checked, so streamed text is provisional.
 * - Only the final `result` can produce citations, and only when the backend accepted them.
 *   The `sources` event lists what the model was *given*; it is never shown as citations.
 * - If the backend rejects the citations or the provider refuses, the streamed text is dropped.
 * - If the stream fails partway, the partial text is kept and marked incomplete, with no
 *   citations, because nothing in it was verified.
 * - If the LLM is down, the retrieved passages are shown instead of an answer.
 *
 * Pure, so every rule is unit-tested.
 */
export type AnswerStatus =
  | 'waiting'      // nothing received yet
  | 'streaming'    // text arriving
  | 'answered'     // final, with verified citations
  | 'dont_know'    // final: the sources don't cover the question
  | 'withheld'     // final: refused, or citations rejected; no text shown
  | 'fallback'     // final: LLM unavailable; passages shown
  | 'incomplete'   // failed partway: partial text kept, marked incomplete
  | 'failed';      // failed before any text

export interface AnswerView {
  status: AnswerStatus;
  text: string;
  /** Verified citations. Non-empty only for status "answered". */
  citations: SourceRef[];
  /** For "fallback": the retrieved passages. */
  passages: Passage[];
  /** Plain explanation of what happened; for "answered", only set when the answer is partial. */
  notice: string | null;
  /** Extra facts about the answer the user should know (documents skipped, truncation). */
  notes: string[];
  /** Number of passages the model was given (unverified, informational). */
  given: number;
}

export const initialAnswer: AnswerView = {
  status: 'waiting', text: '', citations: [], passages: [], notice: null, notes: [], given: 0,
};

export const FINAL: ReadonlySet<AnswerStatus> = new Set(['answered', 'dont_know', 'withheld', 'fallback', 'incomplete', 'failed']);

export function reduceAnswer(view: AnswerView, event: StreamEvent): AnswerView {
  if (FINAL.has(view.status)) return view; // nothing changes a finished answer
  switch (event.type) {
    case 'sources':
      return { ...view, given: event.sources.length };
    case 'delta':
      return { ...view, status: 'streaming', text: view.text + event.text };
    case 'result':
      return fromResult(view, event.result);
    case 'error':
    case 'cut':
      return failed(view, event.message);
  }
}

function failed(view: AnswerView, reason: string): AnswerView {
  if (view.text.trim()) {
    return {
      ...view, status: 'incomplete', citations: [],
      notice: `This answer is incomplete: ${reason} Its sources were never checked, so none are shown.`,
    };
  }
  return { ...view, status: 'failed', text: '', citations: [], notice: reason };
}

function notesOf(r: AnswerResult): string[] {
  const notes: string[] = [];
  if (r.excludedDocuments > 0) {
    notes.push(`${plural(r.excludedDocuments, 'document was', 'documents were')} not searched, because they aren't allowed to be sent to the hosted model.`);
  }
  if (r.omittedForContext > 0) {
    notes.push(`${plural(r.omittedForContext, 'retrieved passage was', 'retrieved passages were')} left out because the prompt was full.`);
  }
  if (r.truncated) notes.push('The answer was cut off at the length limit.');
  return notes;
}

function fromResult(view: AnswerView, r: AnswerResult): AnswerView {
  const base = { ...view, notes: notesOf(r), given: r.sourcesGiven ?? view.given };
  switch (r.outcome) {
    case 'answered':
      return { ...base, status: 'answered', text: r.answer ?? view.text, citations: r.citations ?? [], notice: r.message ?? null };
    case 'dont_know':
      return {
        ...base, status: 'dont_know', text: r.answer ?? '', citations: [],
        notice: "SMOI's documents don't cover this question.",
      };
    case 'refused':
      return {
        ...base, status: 'withheld', text: '', citations: [],
        notice: `The language model's safety system declined to answer${r.refusalCategory ? ` (${r.refusalCategory})` : ''}.`,
      };
    case 'citation_rejected':
      return {
        ...base, status: 'withheld', text: '', citations: [],
        notice: 'The answer was withheld because it cited sources SMOI never gave the model, so it could not be trusted.',
      };
    case 'llm_unavailable':
      return {
        ...base, status: 'fallback', text: '', citations: [], passages: r.passages ?? [],
        notice: "The language model is unavailable, so SMOI couldn't write an answer. Here are the passages it found.",
      };
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "report.pdf, page 3", "notes.txt, Methods", "a.pdf, pages 2-3": where a source is. */
export function describeSource(s: Pick<SourceRef, 'filename' | 'pageStart' | 'pageEnd' | 'section'>): string {
  const parts = [s.filename];
  if (s.pageStart != null) {
    parts.push(s.pageEnd != null && s.pageEnd !== s.pageStart ? `pages ${s.pageStart}-${s.pageEnd}` : `page ${s.pageStart}`);
  }
  if (s.section) parts.push(s.section);
  return parts.join(', ');
}
