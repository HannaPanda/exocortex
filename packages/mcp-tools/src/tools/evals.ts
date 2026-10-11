import { z } from 'zod';

import {
  cancelEvalRunResponseSchema,
  createEvalCaseRequestSchema,
  deleteEvalResponseSchema,
  type EvalAttempt,
  evalAttemptResponseSchema,
  type EvalCase,
  evalCaseFromRunRequestSchema,
  evalCaseListResponseSchema,
  evalCaseResponseSchema,
  type EvalComparison,
  evalComparisonSchema,
  type EvalRun,
  evalRunDetailResponseSchema,
  evalRunListResponseSchema,
  evalSuiteFileSchema,
  evalVariantSchema,
  idSchema,
  importEvalSuiteRequestSchema,
  importEvalSuiteResponseSchema,
  reviewEvalAttemptRequestSchema,
  updateEvalCaseRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Agent evals (issue #146, ADR-074).
 *
 * Reading cases, runs, attempts and the comparison is on both agent
 * surfaces. Everything that writes a case or starts, stops or judges a run
 * is on MCP only: an eval measures the built-in AI, and a run that could
 * write its own exam, start paid runs of itself or grade its own attempts
 * would not be measured by it.
 */

const CASE_HELP =
  'Ein Fall: name, prompt (die Aufgabe, wörtlich), replayMode (read_only: echte Seiten, ' +
  'nichts ändern; propose: Vorschläge, die am Ende abgelehnt werden; fixture: eigene Seiten in ' +
  'einer Sandbox, nur dort darf der Lauf schreiben), documentId (Startseite bei read_only/' +
  'propose), fixture ({ pages: [{ key, title, markdown, parentKey }], startKey }), ' +
  'agentProfileId, toolDomains, budgetMicroUsd, maxToolIterations, maxRunSeconds, suite ' +
  '(z. B. regression), expectedOutcome (für die Prüfung in Worten). invariants und criteria ' +
  'sind Listen von Prüfungen mit id und kind: answer_contains/answer_excludes (text), ' +
  'answer_matches (pattern, flags, min, max), tool_called (tool, min, max), tool_not_called ' +
  '(tool), max_tool_calls (max), max_failed_tool_calls (max), max_cost (maxMicroUsd), ' +
  'max_duration (maxSeconds), no_changes, page_contains/page_excludes (page = Fixture-Schlüssel, ' +
  'text), pages_created (min, max), proposed_changes (min, max), manual (text, entscheidet ein ' +
  'Mensch). Eine verletzte Invariante lässt den Versuch scheitern, egal wie der Rest ausgeht.';

function money(microUsd: number | null): string {
  return microUsd === null ? '–' : `${(microUsd / 1_000_000).toFixed(4)} $`;
}

function seconds(ms: number | null): string {
  return ms === null ? '–' : `${(ms / 1_000).toFixed(1)} s`;
}

function formatCase(evalCase: EvalCase): string {
  const lines = [
    `${evalCase.name} (id: ${evalCase.id}, Stand ${evalCase.revision})` +
      (evalCase.suite === null ? '' : ` · Suite ${evalCase.suite}`),
    `Modus: ${evalCase.replayMode}` +
      (evalCase.documentTitle === null ? '' : ` · Startseite: ${evalCase.documentTitle}`) +
      (evalCase.fixture === null ? '' : ` · ${evalCase.fixture.pages.length} Fixture-Seiten`) +
      (evalCase.agentProfileName === null ? '' : ` · Profil: ${evalCase.agentProfileName}`),
    `Prüfungen: ${evalCase.invariants.length} Invarianten, ${evalCase.criteria.length} Kriterien` +
      ` · ${evalCase.attemptCount} Versuche`,
  ];
  if (evalCase.description !== null) lines.push(evalCase.description);
  return lines.join('\n');
}

function formatAttempt(attempt: EvalAttempt): string {
  const metrics = attempt.metrics;
  const head =
    `${attempt.caseName} · ${attempt.variantLabel} #${attempt.repetition} (id: ${attempt.id}): ` +
    `${attempt.status}` +
    (attempt.outcome === null ? '' : ` → ${attempt.outcome}`) +
    (attempt.errorCode === null ? '' : ` [${attempt.errorCode}]`);
  const lines = [head];
  if (metrics !== null) {
    lines.push(
      `  ${seconds(metrics.durationMs)} · ${money(metrics.costMicroUsd)}` +
        `${metrics.costEstimated ? ' (geschätzt)' : ''} · ${metrics.inputTokens ?? '–'}/` +
        `${metrics.outputTokens ?? '–'} Token · ${metrics.toolCalls} Werkzeugaufrufe` +
        ` (${metrics.failedToolCalls} fehlgeschlagen) · Anbieter: ${metrics.providers.join(', ') || '–'}`,
    );
  }
  for (const result of attempt.assertions) {
    const mark = result.passed === null ? '?' : result.passed ? '✓' : '✗';
    lines.push(
      `  ${mark} ${result.role === 'invariant' ? 'Invariante' : 'Kriterium'} ${result.id} (${result.kind})` +
        (result.actual === null ? '' : `: ${result.actual}`),
    );
  }
  if (attempt.review !== null) {
    lines.push(
      `  Prüfung: ${attempt.review.verdict ?? '–'}` +
        (attempt.review.score === null ? '' : ` · ${attempt.review.score}/5`) +
        (attempt.review.note === null ? '' : ` · ${attempt.review.note}`),
    );
  }
  return lines.join('\n');
}

function formatRun(run: EvalRun): string {
  const { counts } = run;
  return (
    `${run.label ?? run.createdAt.slice(0, 16)} (id: ${run.id})` +
    (run.suite === null ? '' : ` · Suite ${run.suite}`) +
    ` · ${run.caseCount} Fälle × ${run.variants.length} Varianten × ${run.repetitions}` +
    `\n  ${counts.finished}/${counts.total} fertig, ${counts.passed} bestanden, ${counts.failed} ` +
    `gescheitert, ${counts.invariantViolated} Invariante verletzt, ${counts.error} Fehler, ` +
    `${counts.queued + counts.running} offen · ${money(run.costMicroUsd)}`
  );
}

function formatComparison(comparison: EvalComparison): string {
  const lines: string[] = [];
  for (const run of comparison.runs) {
    lines.push(`Lauf ${run.label ?? run.id}:`);
    for (const entry of comparison.cases) {
      for (const variant of comparison.variants) {
        const cell = comparison.cells.find(
          (candidate) =>
            candidate.evalRunId === run.id &&
            candidate.caseKey === entry.key &&
            candidate.variantLabel === variant,
        );
        if (cell === undefined) continue;
        lines.push(
          `  ${entry.name} · ${variant}: ${cell.passed}/${cell.finished} bestanden` +
            (cell.invariantViolated > 0 ? `, ${cell.invariantViolated}× Invariante verletzt` : '') +
            ` · Ø ${seconds(cell.meanDurationMs)} · Ø ${money(cell.meanCostMicroUsd)}` +
            ` · Ø ${cell.meanToolCalls?.toFixed(1) ?? '–'} Aufrufe` +
            (cell.reviewed > 0 ? ` · Prüfung ${cell.reviewedPassed}/${cell.reviewed}` : ''),
        );
      }
    }
  }
  return lines.length === 0 ? 'Noch keine Versuche.' : lines.join('\n');
}

const caseListTool = defineTool({
  name: 'exo_eval_case_list',
  description:
    'Listet die Eval-Fälle eines Arbeitsbereichs: gespeicherte Agentenaufgaben mit Prüfungen, ' +
    'die gegen Modelle und Anbieter wiederholt werden. suite filtert auf ein Set (z. B. regression).',
  inputSchema: z.object({ workspaceId: idSchema, suite: z.string().max(60).optional() }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/eval-cases`,
      ...(input.suite === undefined ? {} : { query: { suite: input.suite } }),
      responseSchema: evalCaseListResponseSchema,
    });
    if (result.cases.length === 0) {
      return { text: 'Keine Eval-Fälle. exo_eval_case_create legt einen an.', data: result };
    }
    return { text: result.cases.map(formatCase).join('\n\n'), data: result };
  },
});

const caseGetTool = defineTool({
  name: 'exo_eval_case_get',
  description:
    'Liest einen Eval-Fall vollständig (Aufgabe, Modus, Prüfungen) mit seinen letzten Versuchen ' +
    'über alle Läufe hinweg.',
  inputSchema: z.object({ caseId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/eval-cases/${input.caseId}`,
      responseSchema: evalCaseResponseSchema,
    });
    const { evalCase } = result;
    const checks = [...evalCase.invariants, ...evalCase.criteria].map(
      (check) => `- ${check.id} (${check.kind}): ${JSON.stringify(check)}`,
    );
    return {
      text: [
        formatCase(evalCase),
        '',
        `Aufgabe:\n${evalCase.prompt}`,
        '',
        'Prüfungen:',
        ...checks,
        '',
        'Letzte Versuche:',
        ...result.recentAttempts.map(formatAttempt),
      ].join('\n'),
      data: result,
    };
  },
});

const caseCreateTool = defineTool({
  name: 'exo_eval_case_create',
  description: `Legt einen Eval-Fall an. ${CASE_HELP}`,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createEvalCaseRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:eval-cases`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/eval-cases`,
      body,
      responseSchema: evalCaseResponseSchema,
    });
    return { text: `Eval-Fall angelegt:\n${formatCase(result.evalCase)}`, data: result };
  },
});

const caseUpdateTool = defineTool({
  name: 'exo_eval_case_update',
  description:
    'Ändert einen Eval-Fall; nur die genannten Felder ändern sich, null leert eines. Jede ' +
    `Änderung erhöht den Stand, frühere Versuche behalten ihren. ${CASE_HELP}`,
  inputSchema: z.object({ caseId: idSchema }).extend(updateEvalCaseRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `eval-case:${input.caseId}`,
  async execute(client, input) {
    const { caseId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/eval-cases/${caseId}`,
      body,
      responseSchema: evalCaseResponseSchema,
    });
    return { text: `Eval-Fall geändert:\n${formatCase(result.evalCase)}`, data: result };
  },
});

const caseDeleteTool = defineTool({
  name: 'exo_eval_case_delete',
  description:
    'Löscht einen Eval-Fall. Seine Versuche bleiben mit dem Stand, gegen den sie gemessen wurden.',
  inputSchema: z.object({ caseId: idSchema }),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `eval-case:${input.caseId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/eval-cases/${input.caseId}`,
      responseSchema: deleteEvalResponseSchema,
    });
    return { text: 'Eval-Fall gelöscht.', data: result };
  },
});

const caseFromRunTool = defineTool({
  name: 'exo_eval_case_from_run',
  description:
    'Macht aus einem echten Lauf der eingebauten KI einen Eval-Fall: Aufgabe, Seite und Profil ' +
    'werden übernommen, die Prüfungen ergänzt man danach mit exo_eval_case_update. replayMode ' +
    'muss man wählen; fixture kopiert die Seite, wie sie jetzt ist.',
  inputSchema: z.object({ runId: idSchema }).extend(evalCaseFromRunRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `ai-run:${input.runId}:eval-case`,
  async execute(client, input) {
    const { runId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/ai/runs/${runId}/eval-case`,
      body,
      responseSchema: evalCaseResponseSchema,
    });
    return {
      text: `Eval-Fall aus dem Lauf angelegt:\n${formatCase(result.evalCase)}`,
      data: result,
    };
  },
});

const suiteExportTool = defineTool({
  name: 'exo_eval_suite_export',
  description:
    'Gibt ein Eval-Set (alle Fälle einer suite) als Datei im Format exocortex.eval-suite/1 ' +
    'zurück, ohne ids, so dass es in einem Repository versioniert und woanders importiert ' +
    'werden kann.',
  inputSchema: z.object({ workspaceId: idSchema, suite: z.string().min(1).max(60) }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/eval-suites/${encodeURIComponent(input.suite)}`,
      responseSchema: evalSuiteFileSchema,
    });
    return { text: JSON.stringify(result, null, 2), data: result };
  },
});

const suiteImportTool = defineTool({
  name: 'exo_eval_suite_import',
  description:
    'Importiert ein Eval-Set aus einer Datei von exo_eval_suite_export. Fälle werden über den ' +
    'Namen zugeordnet: vorhandene geändert, neue angelegt. Eine Startseite oder ein Profil, das ' +
    'es hier nicht gibt, fällt weg.',
  inputSchema: z.object({ workspaceId: idSchema }).extend(importEvalSuiteRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:eval-cases`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/eval-suites/import`,
      body,
      responseSchema: importEvalSuiteResponseSchema,
    });
    const skipped = result.skipped.map((entry) => `- ${entry.name}: ${entry.reason}`);
    return {
      text:
        `${result.created} angelegt, ${result.updated} geändert, ${result.unchanged} unverändert.` +
        (skipped.length === 0 ? '' : `\nÜbersprungen:\n${skipped.join('\n')}`),
      data: result,
    };
  },
});

const runStartTool = defineTool({
  name: 'exo_eval_run_start',
  description:
    'Startet einen Eval-Lauf: die Fälle (caseIds oder eine ganze suite) je Variante ' +
    '(modelSlug, reasoningLevel, providerRouting wie { only: ["deepinfra"] }, label) und ' +
    'repetitions-mal. Jeder Versuch ist ein bezahlter Lauf der eingebauten KI, höchstens 60 je ' +
    'Eval-Lauf. Antwortet sofort; den Fortschritt liest exo_eval_run_get.',
  inputSchema: z.object({
    workspaceId: idSchema,
    caseIds: z.array(idSchema).min(1).max(20).optional(),
    suite: z.string().min(1).max(60).optional(),
    variants: z.array(evalVariantSchema).min(1).max(6),
    repetitions: z.number().int().min(1).max(5).default(1),
    label: z.string().max(120).nullable().optional(),
  }),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:eval-runs`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/eval-runs`,
      body,
      responseSchema: evalRunDetailResponseSchema,
    });
    return { text: `Eval-Lauf gestartet:\n${formatRun(result.run)}`, data: result };
  },
});

const runListTool = defineTool({
  name: 'exo_eval_run_list',
  description: 'Listet die Eval-Läufe eines Arbeitsbereichs, neueste zuerst, mit Stand und Kosten.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/eval-runs`,
      responseSchema: evalRunListResponseSchema,
    });
    if (result.runs.length === 0) return { text: 'Noch keine Eval-Läufe.', data: result };
    return { text: result.runs.map(formatRun).join('\n'), data: result };
  },
});

const runGetTool = defineTool({
  name: 'exo_eval_run_get',
  description:
    'Liest einen Eval-Lauf: jeden Versuch mit Status, Ergebnis, Messwerten und Prüfungen, und ' +
    'den Vergleich je Fall und Variante.',
  inputSchema: z.object({ evalRunId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/eval-runs/${input.evalRunId}`,
      responseSchema: evalRunDetailResponseSchema,
    });
    return {
      text: [
        formatRun(result.run),
        '',
        formatComparison(result.comparison),
        '',
        ...result.attempts.map(formatAttempt),
      ].join('\n'),
      data: result,
    };
  },
});

const compareTool = defineTool({
  name: 'exo_eval_compare',
  description:
    'Stellt bis zu fünf Eval-Läufe nebeneinander: je Fall und Variante bestanden, Dauer, Kosten, ' +
    'Werkzeugaufrufe und Prüfung. Fälle werden über ihren Namen zugeordnet.',
  inputSchema: z.object({ runIds: z.array(idSchema).min(1).max(5) }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: '/api/eval-comparison',
      query: { runIds: input.runIds.join(',') },
      responseSchema: evalComparisonSchema,
    });
    return { text: formatComparison(result), data: result };
  },
});

const attemptGetTool = defineTool({
  name: 'exo_eval_attempt_get',
  description:
    'Liest einen Eval-Versuch mit der Antwort des Laufs, den Endständen der Fixture-Seiten, den ' +
    'Vorschlägen und allen Messwerten. Den Lauf selbst zeigt exo_ai_run_inspect.',
  inputSchema: z.object({ attemptId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'evals',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/eval-attempts/${input.attemptId}`,
      responseSchema: evalAttemptResponseSchema,
    });
    const { attempt } = result;
    return {
      text: [
        formatAttempt(attempt),
        ...(attempt.aiRunId === null ? [] : [`Lauf: ${attempt.aiRunId}`]),
        '',
        `Antwort:\n${attempt.answer ?? '–'}`,
      ].join('\n'),
      data: result,
    };
  },
});

const runCancelTool = defineTool({
  name: 'exo_eval_run_cancel',
  description:
    'Bricht die offenen Versuche eines Eval-Laufs ab. Fertige bleiben, wie sie sind; was die ' +
    'abgebrochenen hinterlassen haben (Sandbox, Vorschläge), wird weggeräumt.',
  inputSchema: z.object({ evalRunId: idSchema }),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `eval-run:${input.evalRunId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/eval-runs/${input.evalRunId}/cancel`,
      responseSchema: cancelEvalRunResponseSchema,
    });
    return {
      text: `${result.cancelledAttempts} Versuche abgebrochen.\n${formatRun(result.run)}`,
      data: result,
    };
  },
});

const runDeleteTool = defineTool({
  name: 'exo_eval_run_delete',
  description:
    'Löscht einen Eval-Lauf mit allen Versuchen und Messwerten; offene werden vorher abgebrochen.',
  inputSchema: z.object({ evalRunId: idSchema }),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `eval-run:${input.evalRunId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/eval-runs/${input.evalRunId}`,
      responseSchema: deleteEvalResponseSchema,
    });
    return { text: 'Eval-Lauf gelöscht.', data: result };
  },
});

const attemptReviewTool = defineTool({
  name: 'exo_eval_attempt_review',
  description:
    'Bewertet einen fertigen Eval-Versuch: verdict (passed, failed), score (1 bis 5), note, und ' +
    'manual mit den Antworten auf die manuellen Prüfungen ({ prüfungsId: true/false }). Die ' +
    'Bewertung steht neben dem automatischen Ergebnis; nur manuelle Prüfungen ändern es.',
  inputSchema: z.object({ attemptId: idSchema }).extend(reviewEvalAttemptRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'evals',
  mutating: true,
  target: (input) => `eval-attempt:${input.attemptId}`,
  async execute(client, input) {
    const { attemptId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/eval-attempts/${attemptId}/review`,
      body,
      responseSchema: evalAttemptResponseSchema,
    });
    return { text: `Bewertet:\n${formatAttempt(result.attempt)}`, data: result };
  },
});

export const EVAL_TOOLS: readonly AnyToolDefinition[] = [
  caseListTool,
  caseGetTool,
  caseCreateTool,
  caseUpdateTool,
  caseDeleteTool,
  caseFromRunTool,
  suiteExportTool,
  suiteImportTool,
  runStartTool,
  runListTool,
  runGetTool,
  compareTool,
  attemptGetTool,
  runCancelTool,
  runDeleteTool,
  attemptReviewTool,
];
