/**
 * gap-schemas.test.js — per-domain schema validation tests (p4r-4).
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md §7.3
 *   - "5 schema validation happy-path tests (one per domain)"
 *   - "5 schema validation rejection tests (wrong source_category, missing
 *      evidence_refs, etc.)"
 *   - "Per-domain schema-purity assertion: a synthetic per-domain analyzer's
 *      gaps[] all have correct source_category"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAP_DOMAINS,
  GAP_SCHEMAS,
  EVIDENCE_PATTERNS,
  URN_PATTERN,
  URN_PATTERN_REGEX,
  GapDomainSchemaError,
  validateGap,
  validateGapDomainSchema,
} from '../lib/gap-schemas.js';

// One well-formed gap per domain — the canonical happy-path fixture.
const HAPPY_GAPS = {
  operational: {
    description:    'Spine state shows entity stuck in PENDING for >5min',
    target_state:   'Entity transitioned to ACTIVE within SLA',
    mission_ref:    'MSP §Operational Continuity',
    evidence_refs:  ['urn:llm-ops:spine-transition:2026-05-02T18:00:00Z-abc123'],
    priority:       'high',
    severity:       0.7,
    source_category: 'operational',
  },
  strategic: {
    description:    'Radiant memory shows declining context-promotion ratio',
    target_state:   'Promotion ratio restored above 30% baseline',
    mission_ref:    'MSP §Strategic Memory Health',
    evidence_refs:  ['urn:llm-ops:radiant-memory:2026-05-02T17:00:00Z-mem01'],
    priority:       'medium',
    severity:       0.55,
    source_category: 'strategic',
  },
  relational: {
    description:    'Minder peer card has not been refreshed in 14 days',
    target_state:   'Peer card refreshed via Minder dream cycle',
    mission_ref:    'MSP §Relational Continuity',
    evidence_refs:  ['urn:llm-ops:minder-peer:leon-7d3f2a'],
    priority:       'low',
    severity:       0.3,
    source_category: 'relational',
  },
  compliance: {
    description:    'Recent governance event lacks tied AP record',
    target_state:   'AP record reconciled with governance event',
    mission_ref:    'BoR Article 4',
    evidence_refs:  ['urn:llm-ops:governance-event:2026-05-02-evt-088'],
    priority:       'critical',
    severity:       0.92,
    source_category: 'compliance',
  },
  constitutional: {
    description:    'Behavior drift relative to BoR §3 detected',
    target_state:   'Behavior realigned with BoR Article 3 commitments',
    mission_ref:    'BoR §3',
    evidence_refs:  ['BoR Article 3'],
    priority:       'critical',
    severity:       0.99,
    source_category: 'constitutional',
  },
};

// Sanity — fixture coverage matches the domain set.
test('HAPPY_GAPS fixture covers all 5 domains', () => {
  assert.deepEqual(Object.keys(HAPPY_GAPS).sort(), [...GAP_DOMAINS].sort());
});

test('GAP_DOMAINS exports 5 canonical domains', () => {
  assert.deepEqual(
    [...GAP_DOMAINS].sort(),
    ['compliance', 'constitutional', 'operational', 'relational', 'strategic'],
  );
});

test('URN_PATTERN_REGEX accepts Cortex hyphenated class names + 3-segment minimum', () => {
  // Hyphenated class segments per actual Cortex URN convention
  assert.ok(URN_PATTERN_REGEX.test('urn:llm-ops:spine-transition:abc'));
  assert.ok(URN_PATTERN_REGEX.test('urn:llm-ops:radiant-memory:r1'));
  assert.ok(URN_PATTERN_REGEX.test('urn:llm-ops:cortex-gap:t-1'));
  // Snake_case class segments (Graph organ convention) also pass
  assert.ok(URN_PATTERN_REGEX.test('urn:test:bor:article-1'));
  assert.ok(URN_PATTERN_REGEX.test('urn:llm-ops:governance_event:evt-1'));
  // 2-segment URN (test-only stub) does NOT satisfy the 3+segment regex
  assert.equal(URN_PATTERN_REGEX.test('urn:e:1'), false);
});

test('EVIDENCE_PATTERNS exports a regex per domain', () => {
  for (const domain of GAP_DOMAINS) {
    assert.equal(typeof EVIDENCE_PATTERNS[domain], 'string', `pattern missing for ${domain}`);
    // Spot-check each pattern compiles
    assert.doesNotThrow(() => new RegExp(EVIDENCE_PATTERNS[domain]));
  }
});

// === HAPPY PATH (5 tests, one per domain) ===

for (const domain of GAP_DOMAINS) {
  test(`gap-${domain} happy-path: well-formed gap validates`, () => {
    assert.equal(validateGap(domain, HAPPY_GAPS[domain]), true);
    assert.equal(validateGapDomainSchema(domain, [HAPPY_GAPS[domain]]), true);
  });
}

// === REJECTION (5 tests, one per domain — different failure mode each) ===

test('gap-operational rejection: source_category mismatch (strategic)', () => {
  const bad = { ...HAPPY_GAPS.operational, source_category: 'strategic' };
  assert.throws(
    () => validateGap('operational', bad),
    (err) => {
      assert.ok(err instanceof GapDomainSchemaError, 'wrong error class');
      assert.equal(err.domain, 'operational');
      assert.match(err.message, /source_category/);
      return true;
    },
  );
});

test('gap-strategic rejection: evidence_refs missing radiant URN', () => {
  const bad = {
    ...HAPPY_GAPS.strategic,
    evidence_refs: ['urn:llm-ops:spine-transition:not-radiant'],
  };
  assert.throws(
    () => validateGap('strategic', bad),
    (err) => {
      assert.ok(err instanceof GapDomainSchemaError);
      assert.equal(err.domain, 'strategic');
      // contains keyword failure
      assert.match(err.message, /evidence_refs|contains/i);
      return true;
    },
  );
});

test('gap-relational rejection: empty evidence_refs', () => {
  const bad = { ...HAPPY_GAPS.relational, evidence_refs: [] };
  assert.throws(
    () => validateGap('relational', bad),
    (err) => {
      assert.ok(err instanceof GapDomainSchemaError);
      assert.match(err.message, /evidence_refs|minItems/i);
      return true;
    },
  );
});

test('gap-compliance rejection: priority not in enum', () => {
  const bad = { ...HAPPY_GAPS.compliance, priority: 'mega-critical' };
  assert.throws(
    () => validateGap('compliance', bad),
    (err) => {
      assert.ok(err instanceof GapDomainSchemaError);
      assert.match(err.message, /priority|enum/i);
      return true;
    },
  );
});

test('gap-constitutional rejection: severity above 1', () => {
  const bad = { ...HAPPY_GAPS.constitutional, severity: 1.5 };
  assert.throws(
    () => validateGap('constitutional', bad),
    (err) => {
      assert.ok(err instanceof GapDomainSchemaError);
      assert.match(err.message, /severity|maximum/i);
      return true;
    },
  );
});

// === SCHEMA-PURITY ASSERTION (spec §7.3 — synthetic analyzer's gaps[] all have correct source_category) ===

test('per-domain schema-purity: synthetic operational analyzer outputs all carry source_category="operational"', () => {
  const syntheticOperational = [
    HAPPY_GAPS.operational,
    {
      ...HAPPY_GAPS.operational,
      description:   'Second operational gap',
      evidence_refs: ['urn:llm-ops:state-transition:event-42'],
    },
    {
      ...HAPPY_GAPS.operational,
      description:   'Third operational gap',
      evidence_refs: ['urn:llm-ops:entity:abc-123'],
    },
  ];
  // Whole batch must pass the operational schema (purity)
  assert.equal(validateGapDomainSchema('operational', syntheticOperational), true);
  // Verify source_category uniformity (spec assertion shape)
  for (const g of syntheticOperational) {
    assert.equal(g.source_category, 'operational');
  }
});

test('per-domain schema-purity: a single off-domain gap in the batch is rejected with index', () => {
  const mixedBatch = [
    HAPPY_GAPS.strategic,                                  // ok
    HAPPY_GAPS.strategic,                                  // ok
    { ...HAPPY_GAPS.strategic, source_category: 'operational' }, // wrong domain at index 2
  ];
  assert.throws(
    () => validateGapDomainSchema('strategic', mixedBatch),
    (err) => {
      assert.ok(err instanceof GapDomainSchemaError);
      assert.equal(err.index, 2, 'error should carry the failing batch index');
      assert.match(err.message, /\[2\]/);
      return true;
    },
  );
});

// === Edge cases for validateGapDomainSchema ===

test('validateGapDomainSchema: empty array passes (no gaps to validate)', () => {
  for (const domain of GAP_DOMAINS) {
    assert.equal(validateGapDomainSchema(domain, []), true);
  }
});

test('validateGapDomainSchema: rejects unknown domain', () => {
  assert.throws(
    () => validateGapDomainSchema('marketing', [HAPPY_GAPS.operational]),
    /Unknown gap domain/,
  );
});

test('validateGapDomainSchema: rejects non-array input', () => {
  assert.throws(
    () => validateGapDomainSchema('operational', { not: 'an array' }),
    /must be an array/,
  );
});

test('validateGap: rejects unknown domain', () => {
  assert.throws(
    () => validateGap('marketing', HAPPY_GAPS.operational),
    /Unknown gap domain/,
  );
});

// === GAP_SCHEMAS shape integrity ===

test('GAP_SCHEMAS pins source_category const per domain', () => {
  for (const domain of GAP_DOMAINS) {
    const schema = GAP_SCHEMAS[domain];
    assert.equal(
      schema.properties.source_category.const,
      domain,
      `schema for ${domain} must pin source_category const`,
    );
    assert.ok(schema.required.includes('source_category'), `${domain} must require source_category`);
    assert.ok(schema.required.includes('evidence_refs'),  `${domain} must require evidence_refs`);
    assert.equal(schema.properties.evidence_refs.minItems, 1, `${domain} evidence_refs minItems must be 1`);
    assert.ok(schema.properties.evidence_refs.contains, `${domain} evidence_refs must declare contains`);
    assert.equal(
      schema.properties.evidence_refs.contains.pattern,
      EVIDENCE_PATTERNS[domain],
      `${domain} contains pattern must match EVIDENCE_PATTERNS`,
    );
  }
});

// === Cross-domain pattern segregation ===

test('cross-domain: operational evidence pattern rejects radiant URN', () => {
  const opPattern = new RegExp(EVIDENCE_PATTERNS.operational);
  assert.equal(opPattern.test('urn:llm-ops:radiant:abc'), false);
});

test('cross-domain: strategic evidence pattern rejects spine-transition URN', () => {
  const strPattern = new RegExp(EVIDENCE_PATTERNS.strategic);
  assert.equal(strPattern.test('urn:llm-ops:spine-transition:abc'), false);
});

test('cross-domain: relational evidence pattern accepts both minder and hippocampus', () => {
  const relPattern = new RegExp(EVIDENCE_PATTERNS.relational);
  assert.ok(relPattern.test('urn:llm-ops:minder-peer:leon'));
  assert.ok(relPattern.test('urn:llm-ops:hippocampus-conversation:conv-1'));
  assert.equal(relPattern.test('urn:llm-ops:radiant:nope'), false);
});

test('cross-domain: compliance accepts both BoR article-ref textual and governance-event URN', () => {
  const compPattern = new RegExp(EVIDENCE_PATTERNS.compliance);
  assert.ok(compPattern.test('BoR Article 4'));
  assert.ok(compPattern.test('BoR §7'));
  assert.ok(compPattern.test('urn:llm-ops:governance-event:evt-1'));
  assert.equal(compPattern.test('urn:llm-ops:radiant:nope'), false);
});

test('cross-domain: constitutional rejects governance-event URN (compliance-only)', () => {
  const conPattern = new RegExp(EVIDENCE_PATTERNS.constitutional);
  assert.ok(conPattern.test('BoR Article 1'));
  assert.ok(conPattern.test('urn:llm-ops:bor:article-3'));
  assert.equal(conPattern.test('urn:llm-ops:governance-event:evt-1'), false);
});
