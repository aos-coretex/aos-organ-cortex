/**
 * p4r-7 precision/recall measurement — 3 match-criterion variants.
 *
 * Per EA RFI-1 reply §"Forward-cache observation: HARD QUALITY-BAR semantic refinement":
 *   - Strict triple: priority + source_category + normalized_description match (LOAD-BEARING; HARD-BLOCKING decision uses this)
 *   - Two-of-three: priority + category required; description ≥0.7 Sørensen-Dice
 *   - Set-overlap:  priority + category buckets only (ignore description)
 *
 * REPORT all three; HARD-BLOCKING uses strict triple (lowest threshold-floor;
 * least false-positive). Other two are documented as supplementary signals
 * for FAIL-mode diagnosis.
 *
 * Pure functions over (legacyGaps, modularGaps) — no I/O.
 */

const PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SOURCE_CATEGORIES = Object.freeze(['operational', 'strategic', 'relational', 'compliance', 'constitutional']);
const SIMILARITY_THRESHOLD = 0.7;

/**
 * Normalize a description string: lowercase, collapse whitespace, strip
 * non-alphanumeric (preserves space). Output is comparison-stable.
 */
export function normalizeDescription(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sørensen-Dice similarity on character bigrams. Returns 0-1 inclusive.
 * Pure function; deterministic; no deps.
 */
export function diceSimilarity(a, b) {
  const na = normalizeDescription(a);
  const nb = normalizeDescription(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.substr(i, 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };

  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const [bg, count] of A.entries()) {
    if (B.has(bg)) inter += Math.min(count, B.get(bg));
  }
  const sizeA = na.length - 1;
  const sizeB = nb.length - 1;
  return (2 * inter) / (sizeA + sizeB);
}

/**
 * Match criterion: STRICT TRIPLE.
 * Two gaps match iff priority equal AND source_category equal AND
 * normalized_description equal.
 */
export function strictTripleMatch(g1, g2) {
  return (
    g1.priority === g2.priority &&
    g1.source_category === g2.source_category &&
    normalizeDescription(g1.description) === normalizeDescription(g2.description)
  );
}

/**
 * Match criterion: TWO-OF-THREE (priority+category required; description ≥0.7).
 */
export function twoOfThreeMatch(g1, g2) {
  if (g1.priority !== g2.priority) return false;
  if (g1.source_category !== g2.source_category) return false;
  return diceSimilarity(g1.description, g2.description) >= SIMILARITY_THRESHOLD;
}

/**
 * Match criterion: SET-OVERLAP (bucket-by-priority+category only).
 *
 * Note: this isn't pairwise-meaningful — it's a bucket-count comparison.
 * We expose a bucket-extractor + bucket-comparator pair instead.
 */
export function bucketize(gaps) {
  const m = new Map();
  for (const g of gaps) {
    const key = `${g.priority}::${g.source_category}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

/**
 * Greedy best-match pairing for strict-triple and two-of-three.
 * For each ground-truth gap, find ONE replay-output gap that matches and
 * is not already taken. Returns { matched: [{gt, ro}], unmatched_gt, unmatched_ro }.
 */
function greedyMatch(groundTruth, replayOutput, matchFn) {
  const taken = new Set();
  const matched = [];
  const unmatched_gt = [];
  for (const gt of groundTruth) {
    let found = -1;
    for (let i = 0; i < replayOutput.length; i++) {
      if (taken.has(i)) continue;
      if (matchFn(gt, replayOutput[i])) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      taken.add(found);
      matched.push({ gt, ro: replayOutput[found] });
    } else {
      unmatched_gt.push(gt);
    }
  }
  const unmatched_ro = replayOutput.filter((_, i) => !taken.has(i));
  return { matched, unmatched_gt, unmatched_ro };
}

/**
 * Compute precision/recall/F1 per priority tier under a given match function.
 *
 * @param {Array<object>} groundTruthGaps   - legacy single-pass output
 * @param {Array<object>} replayOutputGaps  - modular per-domain output
 * @param {Function}      matchFn           - (g1, g2) => boolean
 * @returns {{ tiers: object, totals: object }}
 */
export function computeTierMetrics(groundTruthGaps, replayOutputGaps, matchFn) {
  const tiers = {};
  for (const tier of PRIORITIES) {
    const gtTier = groundTruthGaps.filter(g => g.priority === tier);
    const roTier = replayOutputGaps.filter(g => g.priority === tier);
    const { matched, unmatched_gt, unmatched_ro } = greedyMatch(gtTier, roTier, matchFn);
    const tp = matched.length;
    const fn = unmatched_gt.length; // ground-truth not matched by replay-output → recall miss
    const fp = unmatched_ro.length; // replay-output not matched by ground-truth → precision miss
    const precision = (tp + fp) === 0 ? null : tp / (tp + fp);
    const recall    = (tp + fn) === 0 ? null : tp / (tp + fn);
    const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
      ? (2 * precision * recall) / (precision + recall)
      : null;
    tiers[tier] = { tp, fp, fn, precision, recall, f1, gt_count: gtTier.length, ro_count: roTier.length };
  }

  // Aggregate totals (micro-averaged across tiers — sum tp/fp/fn first, then compute)
  let totTp = 0, totFp = 0, totFn = 0;
  for (const tier of PRIORITIES) {
    totTp += tiers[tier].tp;
    totFp += tiers[tier].fp;
    totFn += tiers[tier].fn;
  }
  const aggregate_precision = (totTp + totFp) === 0 ? null : totTp / (totTp + totFp);
  const aggregate_recall    = (totTp + totFn) === 0 ? null : totTp / (totTp + totFn);
  const aggregate_f1 = (aggregate_precision !== null && aggregate_recall !== null && (aggregate_precision + aggregate_recall) > 0)
    ? (2 * aggregate_precision * aggregate_recall) / (aggregate_precision + aggregate_recall)
    : null;

  return {
    tiers,
    totals: {
      tp: totTp,
      fp: totFp,
      fn: totFn,
      precision: aggregate_precision,
      recall:    aggregate_recall,
      f1:        aggregate_f1,
    },
  };
}

/**
 * Run all 3 match-criterion variants on a single fixture's (legacy, modular)
 * pair. Returns metrics under each variant.
 */
export function compareFixture(legacyGaps, modularGaps) {
  return {
    strict_triple: computeTierMetrics(legacyGaps, modularGaps, strictTripleMatch),
    two_of_three:  computeTierMetrics(legacyGaps, modularGaps, twoOfThreeMatch),
    set_overlap_buckets: {
      legacy_buckets: Object.fromEntries(bucketize(legacyGaps)),
      modular_buckets: Object.fromEntries(bucketize(modularGaps)),
    },
  };
}

/**
 * Aggregate precision/recall across an array of fixture-replay results.
 * Concatenate all gaps across fixtures into one big set, then compute metrics.
 * This is the corpus-level metric used for HARD QUALITY-BAR enforcement.
 *
 * @param {Array<{legacy_gaps, modular_gaps}>} fixtureResults
 */
export function aggregateAcrossFixtures(fixtureResults) {
  // Concat all legacy + all modular gaps; track origin fixture for diagnostic
  const allLegacy = [];
  const allModular = [];
  for (const r of fixtureResults) {
    for (const g of r.legacy_gaps) allLegacy.push({ ...g, _fixture_id: r.fixture_id });
    for (const g of r.modular_gaps) allModular.push({ ...g, _fixture_id: r.fixture_id });
  }
  return {
    strict_triple: computeTierMetrics(allLegacy, allModular, (a, b) =>
      a._fixture_id === b._fixture_id && strictTripleMatch(a, b),
    ),
    two_of_three: computeTierMetrics(allLegacy, allModular, (a, b) =>
      a._fixture_id === b._fixture_id && twoOfThreeMatch(a, b),
    ),
    set_overlap_buckets: {
      legacy_buckets: Object.fromEntries(bucketize(allLegacy)),
      modular_buckets: Object.fromEntries(bucketize(allModular)),
    },
    total_legacy_gaps: allLegacy.length,
    total_modular_gaps: allModular.length,
    fixture_count: fixtureResults.length,
  };
}

/**
 * Distribution-criterion check: parent MP §Acceptance + Step 1 selection criteria.
 *
 * @param {Array<{legacy_gaps}>} fixtureResults
 * @returns {{ ok: boolean, breakdown: object, missing: string[] }}
 */
export function checkDistributionCriterion(fixtureResults) {
  let critical = 0, high = 0;
  const byCategory = Object.fromEntries(SOURCE_CATEGORIES.map(c => [c, 0]));
  for (const r of fixtureResults) {
    for (const g of (r.legacy_gaps || [])) {
      if (g.priority === 'critical') critical += 1;
      if (g.priority === 'high') high += 1;
      if (byCategory[g.source_category] !== undefined) {
        byCategory[g.source_category] += 1;
      }
    }
  }
  const missing = [];
  if (critical < 10) missing.push(`critical:${critical}<10`);
  if (high < 15) missing.push(`high:${high}<15`);
  // Source-category balance: at least 1 gap per category preferred (not gated)
  return {
    ok: missing.length === 0,
    breakdown: { critical, high, by_source_category: byCategory },
    missing,
  };
}

export const PRECISION_RECALL_CONSTANTS = Object.freeze({
  PRIORITIES,
  SOURCE_CATEGORIES,
  SIMILARITY_THRESHOLD,
});
