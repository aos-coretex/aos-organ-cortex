/**
 * p4r-7 supplementary measurements (Steps 5, 6, 7) per CEO 2014 R dispositions
 * (forward-cache observations 2-4 from p4r-staging).
 *
 * Step 5: cross-pollination measurement — gaps emitted by per-domain analyzers
 *         with mismatched source_category. Threshold-flag if any domain >0.20.
 * Step 6: markdown-fence verification — raw LLM responses fenced/unfenced;
 *         parse-failure rate. Threshold-flag if >0.05 parse-failure.
 * Step 7: constitutional-emission baseline — cycles emitting constitutional
 *         gaps; flag if 0 across sustained windows (≥30 cycles).
 *
 * Pure functions over harness-produced replay results — no I/O.
 */

const SOURCE_CATEGORIES = Object.freeze(['operational', 'strategic', 'relational', 'compliance', 'constitutional']);
const CROSS_POLLINATION_THRESHOLD = 0.20;
const MARKDOWN_PARSE_FAILURE_THRESHOLD = 0.05;
const CONSTITUTIONAL_BASELINE_MIN_CYCLES = 30;

/**
 * Step 5 — cross-pollination measurement.
 *
 * For each per-domain analyzer's output across all fixtures, count gaps whose
 * source_category does not match the analyzer's own domain. The per-domain
 * schema gate at p4r-4 SHOULD reject these (validateGapDomainSchema asserts
 * source_category const per-domain), so non-zero cross-pollination indicates
 * either schema-validation bypass or pre-validation per-domain analyzers
 * emitting wrong-domain gaps.
 *
 * @param {Array<{per_domain_outputs}>} modularReplays - replay results from
 *   replayModular(); each per_domain_outputs is [{domain, gaps, degraded}].
 */
export function measureCrossPollination(modularReplays) {
  const perDomain = Object.fromEntries(
    SOURCE_CATEGORIES.map(d => [d, { total_gaps_emitted: 0, cross_pollinated_gaps: 0 }]),
  );

  for (const replay of modularReplays) {
    for (const out of (replay.per_domain_outputs || [])) {
      const stats = perDomain[out.domain];
      if (!stats) continue;
      for (const g of (out.gaps || [])) {
        stats.total_gaps_emitted += 1;
        if (g.source_category !== out.domain) {
          stats.cross_pollinated_gaps += 1;
        }
      }
    }
  }

  const result = {};
  let anyAboveThreshold = false;
  for (const d of SOURCE_CATEGORIES) {
    const stats = perDomain[d];
    const rate = stats.total_gaps_emitted === 0
      ? 0
      : stats.cross_pollinated_gaps / stats.total_gaps_emitted;
    const flagged = rate > CROSS_POLLINATION_THRESHOLD;
    if (flagged) anyAboveThreshold = true;
    result[d] = {
      total_gaps_emitted: stats.total_gaps_emitted,
      cross_pollinated_gaps: stats.cross_pollinated_gaps,
      cross_pollination_rate: rate,
      threshold: CROSS_POLLINATION_THRESHOLD,
      flagged,
    };
  }
  return {
    by_domain: result,
    any_above_threshold: anyAboveThreshold,
    threshold: CROSS_POLLINATION_THRESHOLD,
  };
}

/**
 * Step 6 — markdown-fence verification.
 *
 * Examine raw LLM responses (legacy + modular). Count how many use ```json
 * fences vs unfenced. Attempt to parse each (after strip-fence) and count
 * parse failures.
 */
export function measureMarkdownFenceUsage(replayResults) {
  const samples = [];
  for (const r of replayResults) {
    if (r.legacy?.raw_response) samples.push({ source: 'legacy', text: r.legacy.raw_response });
    for (const text of (r.modular?.raw_responses || [])) {
      if (text) samples.push({ source: 'modular', text });
    }
  }

  let fenced = 0, unfenced = 0, parseFailures = 0;
  for (const s of samples) {
    const text = s.text;
    const hasFence = /```/.test(text);
    if (hasFence) fenced += 1; else unfenced += 1;
    const stripped = text.replace(/```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      JSON.parse(stripped);
    } catch {
      parseFailures += 1;
    }
  }

  const total = samples.length;
  const parse_failure_rate = total === 0 ? 0 : parseFailures / total;
  return {
    total_samples: total,
    fenced_count: fenced,
    unfenced_count: unfenced,
    parse_failure_count: parseFailures,
    parse_failure_rate,
    threshold: MARKDOWN_PARSE_FAILURE_THRESHOLD,
    flagged: parse_failure_rate > MARKDOWN_PARSE_FAILURE_THRESHOLD,
  };
}

/**
 * Step 7 — constitutional-emission baseline.
 *
 * Across all replayed cycles (legacy ground-truth used as authoritative),
 * count cycles emitting at least one gap with source_category=constitutional.
 * Flag if rate is 0 across ≥30-cycle window.
 */
export function measureConstitutionalEmissionBaseline(replayResults) {
  const cyclesWithConstitutional = new Set();
  let totalConstitutionalGaps = 0;
  for (const r of replayResults) {
    const constitutional = (r.legacy?.gaps || []).filter(g => g.source_category === 'constitutional');
    totalConstitutionalGaps += constitutional.length;
    if (constitutional.length > 0) cyclesWithConstitutional.add(r.fixture_id);
  }
  const total_cycles = replayResults.length;
  const emission_rate = total_cycles === 0 ? 0 : cyclesWithConstitutional.size / total_cycles;
  const sustained_window_eligible = total_cycles >= CONSTITUTIONAL_BASELINE_MIN_CYCLES;
  const flagged = sustained_window_eligible && emission_rate === 0;
  return {
    total_cycles,
    cycles_with_constitutional_gap: cyclesWithConstitutional.size,
    constitutional_emission_rate: emission_rate,
    total_constitutional_gaps_emitted: totalConstitutionalGaps,
    sustained_window_eligible,
    sustained_window_threshold_cycles: CONSTITUTIONAL_BASELINE_MIN_CYCLES,
    flagged,
  };
}

export const SUPPLEMENTARY_THRESHOLDS = Object.freeze({
  CROSS_POLLINATION_THRESHOLD,
  MARKDOWN_PARSE_FAILURE_THRESHOLD,
  CONSTITUTIONAL_BASELINE_MIN_CYCLES,
});
