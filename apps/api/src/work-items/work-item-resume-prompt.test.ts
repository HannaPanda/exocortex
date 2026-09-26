import { describe, expect, it } from 'vitest';

import { buildResumePrompt, type ResumeAnswer } from './work-item-resume-prompt';

const base: ResumeAnswer = {
  attentionItemId: 'att_1',
  kind: 'approval',
  title: 'Darf ich umschreiben?',
  status: 'resolved',
  optionId: 'yes',
  optionLabel: 'Ja',
  note: null,
  obsoleteReason: null,
  answeredBy: 'Johanna',
  action: 'Abschnitt „Ziele“ neu schreiben',
  subject: {
    kind: 'pages',
    pages: [{ documentId: 'doc_1', revision: '2026-09-26T10:00:00.000Z' }],
  },
  subjectTitles: new Map([['doc_1', 'Projektplan']]),
};

describe('buildResumePrompt (issue #140)', () => {
  it('names the approved action and the revision every write has to send', () => {
    const text = buildResumePrompt({
      workItem: { id: 'wi_1', title: 'Plan' },
      answers: [base],
      workState: 'Gliederung fertig.',
    });
    expect(text).toContain('Gewählt: Ja (yes)');
    expect(text).toContain('Beantwortet von Johanna.');
    expect(text).toContain('Abschnitt „Ziele“ neu schreiben');
    expect(text).toContain(
      'Projektplan (id: doc_1, expectedYjsUpdatedAt: 2026-09-26T10:00:00.000Z)',
    );
    expect(text).toContain('Gliederung fertig.');
    expect(text).toContain('exo_work_item_update (workItemId wi_1)');
  });

  it('says a stale approval approved nothing and hands on no revision', () => {
    const text = buildResumePrompt({
      workItem: { id: 'wi_1', title: 'Plan' },
      answers: [{ ...base, status: 'obsolete', obsoleteReason: 'subject_changed', subject: null }],
      workState: null,
    });
    expect(text).toContain('Nicht freigegeben');
    expect(text).not.toContain('Gewählt');
    expect(text).not.toContain('expectedYjsUpdatedAt:');
  });

  it('words the options a state raises, which carry no label of their own', () => {
    const text = buildResumePrompt({
      workItem: { id: 'wi_1', title: 'Plan' },
      answers: [
        {
          ...base,
          kind: 'review',
          optionId: 'return',
          optionLabel: null,
          note: 'Fazit fehlt',
          action: null,
          subject: null,
        },
      ],
      workState: null,
    });
    expect(text).toContain('Gewählt: zurückgegeben (return)');
    expect(text).toContain('Antwort: Fazit fehlt');
  });
});
