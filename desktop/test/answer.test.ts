import { describe, expect, it } from 'vitest';
import { describeSource, initialAnswer, reduceAnswer, type AnswerView } from '../src/shared/answer';
import type { AnswerResult, StreamEvent } from '../src/shared/apiTypes';

const cite = { label: 'S1', chunkId: 'c1', documentId: 'd1', filename: 'frogs.pdf', chunkIndex: 0, pageStart: 2, pageEnd: 2, section: null };
const base: AnswerResult = {
  outcome: 'answered', answer: 'Frogs are amphibians [S1].', message: null, citations: [cite], invalidCitations: [],
  refusalCategory: null, provider: 'ollama', model: 'm', mode: 'hybrid', sourcesGiven: 3, excludedDocuments: 0,
  omittedForContext: 0, truncated: false, passages: null,
};
const run = (...events: StreamEvent[]): AnswerView => events.reduce(reduceAnswer, initialAnswer);

describe('answer display rules', () => {
  it('the sources event is never shown as citations', () => {
    const v = run({ type: 'sources', sources: [cite] }, { type: 'delta', text: 'Frogs' });
    expect(v.citations).toEqual([]);
    expect(v.given).toBe(1);
    expect(v.status).toBe('streaming');
  });

  it('an answered result shows the verified citations', () => {
    const v = run({ type: 'delta', text: 'Frogs' }, { type: 'result', result: base });
    expect(v.status).toBe('answered');
    expect(v.text).toBe('Frogs are amphibians [S1].');
    expect(v.citations).toEqual([cite]);
  });

  it('a stream that fails partway keeps the text, marks it incomplete, and shows no citations', () => {
    const v = run({ type: 'sources', sources: [cite] }, { type: 'delta', text: 'Frogs are amph' },
      { type: 'cut', message: 'The connection to the backend was lost.' });
    expect(v.status).toBe('incomplete');
    expect(v.text).toBe('Frogs are amph');
    expect(v.citations).toEqual([]);
    expect(v.notice).toBe('This answer is incomplete: The connection to the backend was lost. Its sources were never checked, so none are shown.');
  });

  it('a failure before any text is a plain failure', () => {
    const v = run({ type: 'error', message: 'The backend reported an error (Internal error).' });
    expect(v.status).toBe('failed');
    expect(v.notice).toBe('The backend reported an error (Internal error).');
  });

  it('rejected citations drop the streamed text', () => {
    const v = run({ type: 'delta', text: 'Made up [S9]' }, { type: 'result', result: { ...base, outcome: 'citation_rejected', answer: null, citations: [] } });
    expect(v.status).toBe('withheld');
    expect(v.text).toBe('');
    expect(v.notice).toMatch(/withheld/);
  });

  it('a refusal drops the streamed text', () => {
    const v = run({ type: 'delta', text: 'x' }, { type: 'result', result: { ...base, outcome: 'refused', answer: null, refusalCategory: 'cyber' } });
    expect(v.status).toBe('withheld');
    expect(v.text).toBe('');
    expect(v.notice).toContain('(cyber)');
  });

  it('LLM fallback shows the passages and says why there is no answer', () => {
    const passage = { ...cite, content: 'Frogs are amphibians.' };
    const v = run({ type: 'result', result: { ...base, outcome: 'llm_unavailable', answer: null, citations: null, passages: [passage] } });
    expect(v.status).toBe('fallback');
    expect(v.passages).toEqual([passage]);
    expect(v.notice).toBe("The language model is unavailable, so SMOI couldn't write an answer. Here are the passages it found.");
  });

  it("don't know is stated plainly", () => {
    const v = run({ type: 'result', result: { ...base, outcome: 'dont_know', answer: "I don't know.", citations: [] } });
    expect(v.status).toBe('dont_know');
    expect(v.notice).toBe("SMOI's documents don't cover this question.");
  });

  it('notes skipped documents, omitted passages and truncation', () => {
    const v = run({ type: 'result', result: { ...base, excludedDocuments: 2, omittedForContext: 1, truncated: true } });
    expect(v.notes).toEqual([
      "2 documents were not searched, because they aren't allowed to be sent to the hosted model.",
      '1 retrieved passage was left out because the prompt was full.',
      'The answer was cut off at the length limit.',
    ]);
  });

  it('nothing changes a finished answer', () => {
    const done = run({ type: 'result', result: base });
    expect(reduceAnswer(done, { type: 'delta', text: 'more' })).toBe(done);
  });

  it('describes where a source is', () => {
    expect(describeSource(cite)).toBe('frogs.pdf, page 2');
    expect(describeSource({ ...cite, pageEnd: 4 })).toBe('frogs.pdf, pages 2-4');
    expect(describeSource({ ...cite, pageStart: null, pageEnd: null, section: 'Methods' })).toBe('frogs.pdf, Methods');
  });
});
