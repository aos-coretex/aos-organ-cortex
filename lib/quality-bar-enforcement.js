/**
 * p4r-7 HARD QUALITY-BAR enforcement.
 *
 * Per parent MP §Acceptance Criterion #2 (CEO 2015 R ratified):
 *   - Critical-tier ≥95% precision AND ≥95% recall
 *   - High-tier    ≥90% precision AND ≥90% recall
 *   - Medium + low NOT gated; reported only
 *   - Aggregate F1 documented
 *
 * Per EA RFI-1 reply forward-cache observation:
 *   - HARD-BLOCKING decision uses STRICT TRIPLE match-criterion only
 *   - Two-of-three + set-overlap reported as supplementary signals for FAIL diagnosis
 *
 * PASS = R8 migration AUTHORIZED.
 * FAIL = R8 migration BLOCKED → block-back to R2-R6 for precision-design refinement.
 */

export const QUALITY_BAR = Object.freeze({
  critical: { precision: 0.95, recall: 0.95 },
  high:     { precision: 0.90, recall: 0.90 },
});

/**
 * Enforce HARD QUALITY-BAR against an aggregate metric set.
 *
 * Three-state verdict:
 *   - PASS: ≥1 measurable (non-null) metric in critical+high tiers AND all
 *           measurable metrics ≥ threshold AND no indeterminate metric in a
 *           tier where the OTHER side has gaps
 *   - FAIL: any measurable metric < threshold OR indeterminate where other side
 *           has gaps (one-sided emptiness — concrete asymmetry)
 *   - INCONCLUSIVE: zero measurable metrics across critical+high tiers (both
 *           legacy and modular emitted 0 gaps in those tiers across all fixtures
 *           — no positive evidence to evaluate; gate cannot conclude)
 *
 * The INCONCLUSIVE state exists because a verdict of FAIL would route to
 * R2-R6 block-back per the relay's heuristic, but "no data" is not a precision-
 * design defect — it's an empirical-state limitation (e.g., bare-bootstrap MSP/
 * BoR yielding 0 gaps from both legacy and modular). INCONCLUSIVE escalates to
 * fixture-corpus enrichment rather than precision-design refinement.
 *
 * @param {object} aggregateMetrics - output of aggregateAcrossFixtures, the
 *   `.strict_triple` field specifically (the load-bearing variant).
 * @returns {{ verdict: 'PASS'|'FAIL'|'INCONCLUSIVE', failures: string[], summary: object }}
 */
export function enforceQualityBar(strictTripleMetrics) {
  const { tiers, totals } = strictTripleMetrics;
  const failures = [];
  let determinateMetrics = 0;

  for (const [tier, threshold] of Object.entries(QUALITY_BAR)) {
    const t = tiers[tier];
    if (!t) {
      failures.push(`${tier}: tier missing from metrics`);
      continue;
    }
    if (t.precision !== null) {
      determinateMetrics += 1;
      if (t.precision < threshold.precision) {
        failures.push(
          `${tier}-precision: ${t.precision.toFixed(4)} < ${threshold.precision} (tp=${t.tp}, fp=${t.fp}, fn=${t.fn})`,
        );
      }
    } else if (t.fn > 0) {
      // tp+fp = 0 but ground-truth has gaps → modular emitted nothing → FAIL
      failures.push(
        `${tier}-precision: indeterminate but ground-truth has ${t.fn} unmatched gaps (one-sided emptiness; modular emitted 0 in this tier)`,
      );
    }

    if (t.recall !== null) {
      determinateMetrics += 1;
      if (t.recall < threshold.recall) {
        failures.push(
          `${tier}-recall: ${t.recall.toFixed(4)} < ${threshold.recall} (tp=${t.tp}, fp=${t.fp}, fn=${t.fn})`,
        );
      }
    } else if (t.fp > 0) {
      // tp+fn = 0 but modular emitted gaps → ground-truth has nothing → FAIL
      failures.push(
        `${tier}-recall: indeterminate but modular emitted ${t.fp} unmatched gaps (one-sided emptiness; ground-truth has 0 in this tier)`,
      );
    }
  }

  let verdict;
  if (determinateMetrics === 0 && failures.length === 0) {
    verdict = 'INCONCLUSIVE';
    failures.push('zero-measurable-metrics-in-critical-and-high-tiers: no positive evidence (both legacy and modular emitted 0 gaps in those tiers across all fixtures)');
  } else if (failures.length === 0) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
  }

  const summary = {
    verdict,
    determinate_metrics: determinateMetrics,
    critical_precision: tiers.critical?.precision,
    critical_recall:    tiers.critical?.recall,
    critical_f1:        tiers.critical?.f1,
    high_precision:     tiers.high?.precision,
    high_recall:        tiers.high?.recall,
    high_f1:            tiers.high?.f1,
    medium_f1:          tiers.medium?.f1,
    low_f1:             tiers.low?.f1,
    aggregate_f1:       totals?.f1 ?? null,
  };

  return { verdict, failures, summary };
}

/**
 * Construct the verdict-routing payload for R7 closure dispatch.
 *
 * On PASS:         R8 migration AUTHORIZED.
 * On FAIL:         enumerate which tier × which axis broke and which R2-R6
 *                  block-back targets (heuristic mapping).
 * On INCONCLUSIVE: gate cannot conclude — escalate to fixture-corpus enrichment
 *                  (e.g., MSP/BoR maturation, longer accumulation window, more
 *                  diverse synthetic-recentGoals patterns) rather than precision-
 *                  design refinement. NOT a block-back to R2-R6.
 */
export function buildForwardAction(verdictResult) {
  if (verdictResult.verdict === 'PASS') {
    return {
      authorize_r8: true,
      block_back_targets: [],
      escalation_required: false,
      reason: 'HARD QUALITY-BAR met under strict-triple match: ≥95/95 critical, ≥90/90 high',
    };
  }
  if (verdictResult.verdict === 'INCONCLUSIVE') {
    return {
      authorize_r8: false,
      block_back_targets: [],
      escalation_required: true,
      reason: 'HARD QUALITY-BAR INCONCLUSIVE: zero positive ground-truth across critical+high tiers. Fixture corpus lacks measurable distribution. Recommend: (a) enrich MSP/BoR substrate so legacy gap-analyzer can produce critical/high gaps, (b) extend Phase 1 capture window for state diversity, (c) expand Phase 2 synthetic recentGoals patterns. NOT a precision-design defect — escalation routes to corpus enrichment, not R2-R6 refinement.',
    };
  }
  // FAIL — heuristic mapping per relay §Quality-bar verdict table
  const blockBack = new Set();
  for (const failure of verdictResult.failures) {
    if (failure.startsWith('critical-')) {
      blockBack.add('R6'); // p4r-6 per-domain factory implementation
      blockBack.add('R4'); // p4r-4 per-domain schemas
    }
    if (failure.startsWith('high-')) {
      blockBack.add('R3'); // p4r-3 world-state decomposition
      blockBack.add('R2'); // p4r-2 instrumentation/baseline
    }
  }
  return {
    authorize_r8: false,
    block_back_targets: Array.from(blockBack).sort(),
    escalation_required: false,
    reason: `HARD QUALITY-BAR FAIL: ${verdictResult.failures.join('; ')}`,
  };
}
