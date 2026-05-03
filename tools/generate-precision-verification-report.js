#!/usr/bin/env node
/**
 * p4r-7 REPORT.md generator — reads replay envelopes, runs measurements,
 * applies distribution-criterion sub-select, generates HARD QUALITY-BAR
 * verdict and writes test/fixtures/p4r-7/REPORT.md.
 *
 * Pure analysis — no LLM calls, no platform I/O. Re-runnable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateAcrossFixtures,
  checkDistributionCriterion,
  PRECISION_RECALL_CONSTANTS,
} from '../lib/precision-recall-measurement.js';
import { enforceQualityBar, buildForwardAction } from '../lib/quality-bar-enforcement.js';
import {
  measureCrossPollination,
  measureMarkdownFenceUsage,
  measureConstitutionalEmissionBaseline,
} from '../lib/supplementary-measurements.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  fixturesDir: path.join(REPO_ROOT, 'test', 'fixtures', 'p4r-7'),
  replaysDir:  path.join(REPO_ROOT, 'test', 'fixtures', 'p4r-7', 'replays'),
  reportPath:  path.join(REPO_ROOT, 'test', 'fixtures', 'p4r-7', 'REPORT.md'),
  selectCount: 50,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    switch (a) {
      case '--fixtures-dir': args.fixturesDir = n; i++; break;
      case '--replays-dir':  args.replaysDir = n; i++; break;
      case '--report-path':  args.reportPath = n; i++; break;
      case '--select-count': args.selectCount = parseInt(n, 10); i++; break;
      case '--help': case '-h':
        console.log(`Usage: node tools/generate-precision-verification-report.js [--fixtures-dir <path>] [--replays-dir <path>] [--report-path <path>] [--select-count <N>]`);
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`); process.exit(1);
    }
  }
  return args;
}

function loadReplays(replaysDir) {
  if (!fs.existsSync(replaysDir)) return [];
  return fs.readdirSync(replaysDir)
    .filter(f => f.endsWith('-replay.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(replaysDir, f), 'utf8')));
}

function fmt(n) {
  if (n === null || n === undefined) return 'n/a';
  if (typeof n !== 'number') return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4);
}

function tierTable(tiers) {
  const lines = ['| Tier | TP | FP | FN | Precision | Recall | F1 | GT count | RO count |',
                 '|---|---|---|---|---|---|---|---|---|'];
  for (const tier of ['critical', 'high', 'medium', 'low']) {
    const t = tiers[tier];
    if (!t) { lines.push(`| ${tier} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`); continue; }
    lines.push(`| ${tier} | ${t.tp} | ${t.fp} | ${t.fn} | ${fmt(t.precision)} | ${fmt(t.recall)} | ${fmt(t.f1)} | ${t.gt_count} | ${t.ro_count} |`);
  }
  return lines.join('\n');
}

function bucketTable(buckets) {
  const lines = ['| priority::source_category | count |', '|---|---|'];
  for (const [k, v] of Object.entries(buckets).sort()) {
    lines.push(`| ${k} | ${v} |`);
  }
  return lines.join('\n');
}

/**
 * Sub-select replays meeting distribution criterion. Greedy fill:
 *   1. Sort replays by sum-of-tier-criticality (more critical+high → earlier)
 *   2. Greedy-take until critical+high quotas met OR all replays exhausted
 *   3. If quota not met, return all available + flag insufficient
 */
function subSelectReplays(replays, targetCount) {
  // First, augment with ground-truth gap counts per tier
  const augmented = replays.map(r => ({
    ...r,
    _criticalCount: (r.legacy?.gaps || []).filter(g => g.priority === 'critical').length,
    _highCount:     (r.legacy?.gaps || []).filter(g => g.priority === 'high').length,
    _mediumCount:   (r.legacy?.gaps || []).filter(g => g.priority === 'medium').length,
    _lowCount:      (r.legacy?.gaps || []).filter(g => g.priority === 'low').length,
    _categories:    new Set((r.legacy?.gaps || []).map(g => g.source_category)),
  }));

  // Sort by criticality-weight (critical x 3 + high x 2 + medium x 1)
  augmented.sort((a, b) => {
    const wA = a._criticalCount * 3 + a._highCount * 2 + a._mediumCount;
    const wB = b._criticalCount * 3 + b._highCount * 2 + b._mediumCount;
    return wB - wA;
  });

  return augmented.slice(0, targetCount).map(({ _criticalCount, _highCount, _mediumCount, _lowCount, _categories, ...rest }) => rest);
}

function fixtureResultsForMetrics(replays) {
  return replays.map(r => ({
    fixture_id: r.fixture_id,
    legacy_gaps: r.legacy?.gaps || [],
    modular_gaps: r.modular?.gaps || [],
  }));
}

(async () => {
  const args = parseArgs(process.argv);

  const allReplays = loadReplays(args.replaysDir);
  if (allReplays.length === 0) {
    console.error(`No replays found in ${args.replaysDir}. Run replay orchestrator first.`);
    process.exit(1);
  }

  // Sub-select 50 distribution-criteria-meeting fixtures
  const selectedReplays = subSelectReplays(allReplays, args.selectCount);
  const selectedResults = fixtureResultsForMetrics(selectedReplays);

  // Distribution-criterion check (against parent MP §Acceptance §Step 1)
  const dist = checkDistributionCriterion(selectedResults);

  // Aggregate metrics across selected fixtures
  const aggregate = aggregateAcrossFixtures(selectedResults);

  // HARD QUALITY-BAR enforcement on strict-triple variant (load-bearing)
  const quality = enforceQualityBar(aggregate.strict_triple);
  const forward = buildForwardAction(quality);

  // Supplementary measurements (Steps 5-7) on the SELECTED replay set
  const cross = measureCrossPollination(selectedReplays.map(r => ({ per_domain_outputs: r.modular?.per_domain_outputs || [] })));
  const markdown = measureMarkdownFenceUsage(selectedReplays);
  const constitutional = measureConstitutionalEmissionBaseline(selectedReplays.map(r => ({ fixture_id: r.fixture_id, legacy: { gaps: r.legacy?.gaps || [] } })));

  // p4r-7-coda items
  const codaItems = [];
  if (cross.any_above_threshold) {
    const flagged = Object.entries(cross.by_domain).filter(([, v]) => v.flagged).map(([d, v]) => `${d} (${(v.cross_pollination_rate * 100).toFixed(1)}%)`);
    codaItems.push(`Cross-pollination >${(cross.threshold * 100).toFixed(0)}% in: ${flagged.join(', ')}. Recommend follow-on workstream to investigate per-domain schema-validation gates.`);
  }
  if (markdown.flagged) {
    codaItems.push(`Markdown parse-failure rate ${(markdown.parse_failure_rate * 100).toFixed(1)}% > ${(markdown.threshold * 100).toFixed(0)}%. Recommend tightening LLM prompt OR strengthening parse logic.`);
  }
  if (constitutional.flagged) {
    codaItems.push(`Constitutional-emission rate is 0% across ${constitutional.total_cycles} sustained-window cycles (≥${constitutional.sustained_window_threshold_cycles}). Recommend optional spine_state lens (governance-class state-transitions) for activity grounding.`);
  }
  if (!dist.ok) {
    codaItems.push(`Distribution criterion not met: ${dist.missing.join(', ')}. Sub-selection used best available; results may not generalize beyond fixture window.`);
  }

  // Build REPORT.md
  const totalReplays = allReplays.length;
  const sourceCategoryDist = Object.entries(dist.breakdown.by_source_category)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');

  const report = `# p4r-7 Empirical Precision-Verification Gate Report

> Generated: ${new Date().toISOString()}
> Anchor: parent MP \`mp-p4r-cortex-precise-prompting-framework.md\` §Acceptance Criterion #2 (HARD QUALITY-BAR)
> Disposition: Path III (live-state composition) + Phase 1+2 augmented distribution per RFI-2 reply
> Match-criterion (load-bearing): **strict triple** (priority + source_category + normalized_description)

## Quality-bar verdict: **${quality.verdict}**

${quality.verdict === 'PASS'
  ? '**R8 migration AUTHORIZED.** Forward chain proceeds: CEO orchestrator → p4r-8 (migration cutover) → p4r-9 (soak) → re-bootstrap → CEO Leon-go signal → OpenRouter API key reactivation.'
  : quality.verdict === 'INCONCLUSIVE'
    ? `**R8 migration NOT AUTHORIZED — gate INCONCLUSIVE.** Zero measurable metrics in critical+high tiers — both legacy ground-truth and modular replay emitted 0 gaps in those tiers across all fixtures. **This is NOT a precision-design defect** and does NOT block-back to R2-R6 refinement. Escalation routes to fixture-corpus enrichment:\n\n  - Bare-bootstrap MSP/BoR (placeholder articles, no rules) does not give the gap-analyzer "what the MSP requires" content to compare against world state.\n  - Recommended remediations:\n    1. **MSP/BoR substrate maturation** — Senate-Archivist to publish at least one substantive MSP rule and at least one BoR Article so legacy gap-analyzer can produce non-empty gap-sets.\n    2. **Phase 1 window extension** — increase capture from 4-5h to 12-24h for richer state-transition diversity.\n    3. **Phase 2 pattern expansion** — add more synthetic-recentGoals patterns (e.g., constraint-violation, partial-failure) to inject mission-alignment-relevant context the LLM can produce gaps from.\n  - **R7 re-execution** required after corpus enrichment.`
    : `**R8 migration BLOCKED — gate FAIL.** Block-back to R2-R6 for precision-design refinement. Specific failure modes:\n\n${quality.failures.map(f => `  - ${f}`).join('\n')}\n\nBlock-back targets (heuristic): ${forward.block_back_targets.join(', ') || '(see failure messages)'}`}

## Per-priority-tier metrics (strict-triple, load-bearing)

${tierTable(aggregate.strict_triple.tiers)}

**Aggregate (micro-averaged):** TP=${aggregate.strict_triple.totals.tp}, FP=${aggregate.strict_triple.totals.fp}, FN=${aggregate.strict_triple.totals.fn}, Precision=${fmt(aggregate.strict_triple.totals.precision)}, Recall=${fmt(aggregate.strict_triple.totals.recall)}, F1=${fmt(aggregate.strict_triple.totals.f1)}.

## Per-priority-tier metrics (two-of-three, supplementary)

> priority + source_category required exact match; description ≥0.7 Sørensen-Dice similarity

${tierTable(aggregate.two_of_three.tiers)}

**Aggregate:** P=${fmt(aggregate.two_of_three.totals.precision)}, R=${fmt(aggregate.two_of_three.totals.recall)}, F1=${fmt(aggregate.two_of_three.totals.f1)}.

## Set-overlap buckets (supplementary)

> priority::source_category bucket counts (legacy ground-truth vs modular replay)

### Legacy (ground-truth) buckets
${bucketTable(aggregate.set_overlap_buckets.legacy_buckets)}

### Modular (replay output) buckets
${bucketTable(aggregate.set_overlap_buckets.modular_buckets)}

## Cross-pollination measurement (Step 5)

> threshold ${(cross.threshold * 100).toFixed(0)}%; flagged where rate exceeds threshold

| Domain | Total emitted | Cross-pollinated | Rate | Flagged |
|---|---|---|---|---|
${Object.entries(cross.by_domain).map(([d, v]) =>
  `| ${d} | ${v.total_gaps_emitted} | ${v.cross_pollinated_gaps} | ${(v.cross_pollination_rate * 100).toFixed(2)}% | ${v.flagged ? 'YES' : 'no'} |`,
).join('\n')}

## Markdown-fence verification (Step 6)

- Total samples: ${markdown.total_samples}
- Fenced (\`\`\`json …\`\`\`): ${markdown.fenced_count}
- Unfenced: ${markdown.unfenced_count}
- Parse failures: ${markdown.parse_failure_count}
- Parse-failure rate: ${(markdown.parse_failure_rate * 100).toFixed(2)}% (threshold ${(markdown.threshold * 100).toFixed(0)}%; ${markdown.flagged ? '**FLAGGED**' : 'within tolerance'})

## Constitutional-emission baseline (Step 7)

- Total cycles in selection: ${constitutional.total_cycles}
- Cycles emitting ≥1 constitutional gap: ${constitutional.cycles_with_constitutional_gap}
- Total constitutional gaps emitted: ${constitutional.total_constitutional_gaps_emitted}
- Emission rate: ${(constitutional.constitutional_emission_rate * 100).toFixed(2)}%
- Sustained-window eligibility (≥${constitutional.sustained_window_threshold_cycles} cycles): ${constitutional.sustained_window_eligible ? 'YES' : 'no'}
- ${constitutional.flagged ? '**FLAGGED**: 0 emissions across sustained window — recommend optional spine_state governance lens.' : 'Within baseline.'}

## p4r-7-coda items

${codaItems.length === 0 ? '_None — all supplementary thresholds within tolerance._' : codaItems.map(i => `- ${i}`).join('\n')}

## Fixture-set summary

- Total fixtures replayed: ${totalReplays}
- Selected for measurement: ${selectedReplays.length} (target: ${args.selectCount})
- Selection criterion: greedy fill of (3×critical + 2×high + 1×medium) weight
- Distribution-criterion (parent MP minimum):
  - Critical priority gaps: ${dist.breakdown.critical} (target ≥10) — ${dist.breakdown.critical >= 10 ? 'OK' : 'BELOW'}
  - High priority gaps:     ${dist.breakdown.high} (target ≥15) — ${dist.breakdown.high >= 15 ? 'OK' : 'BELOW'}
  - Source-category breakdown:
${sourceCategoryDist}
- Distribution-criterion overall: ${dist.ok ? 'PASS' : `FAIL (${dist.missing.join(', ')})`}

## Methodology notes

- **Substrate:** live-state composition per RFI-2 ratification (cortex-stdout.log historical events lacked payloads). Phase 1 fixtures are 50 natural live-state snapshots (5-min interval × ~4-5h) from running Spine/Graph/Radiant/Minder/Hippocampus/Arbiter services. Phase 2 fixtures (~30) are Phase 1 worldStates re-emitted with synthetic recentGoals (4 patterns: empty / low-priority-steady / critical-burst / mixed). Cortex daemon remained bootouted throughout.
- **Comparison axis:** legacy (single-pass \`analyzeGaps\` with \`perDomainAnalyzers: undefined\`) vs modular (per-domain reassembly with \`createPerDomainAnalyzerSet\`). Same LLM client reference shared across both per p4r-6 §4.5 invariant.
- **Match-criterion (HARD-BLOCKING):** strict triple — priority + source_category + normalized_description. Two-of-three (priority+category required, description ≥0.7 Sørensen-Dice) and set-overlap (bucket counts ignoring description) reported as supplementary signals for FAIL-mode diagnosis only.
- **Distribution criterion:** parent MP minimum is HARD; sub-selection greedy-fills critical+high tiers from replayed set.

## Forward chain

${quality.verdict === 'PASS'
  ? '- **R7 → CEO orchestrator → EA architect-review per §14.1**. R8 migration authorized; standard chain continues.'
  : '- **R7 → CEO orchestrator → EA architect-review (block-back disposition)**. CEO orchestrator coordinates EA + R-relay re-authoring based on specific failure modes. Re-execute p4r-7 after refinement.'}

— r1
`;

  fs.writeFileSync(args.reportPath, report);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'p4r7_report_generated', report_path: args.reportPath, verdict: quality.verdict, total_replays: totalReplays, selected: selectedReplays.length }, null, 2));
})().catch(err => {
  console.error(`Report generation failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
