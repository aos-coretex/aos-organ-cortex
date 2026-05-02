/**
 * Per-domain gap schemas (p4r-4) — AJV-compileable JSON Schema definitions
 * for the 5 gap source_category values (operational / strategic / relational /
 * compliance / constitutional).
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md
 *   §7.3 — "decompose the unified gaps[] output schema into 5 per-domain
 *   schemas with tighter per-field constraints."
 *
 * Pattern parity: the schemas mirror Graph organ's binding.schema.json /
 * concept.schema.json AJV pattern (per p4r-1 spec §4.1 reference). Shared URN
 * regex follows Graph concept.schema.json with one widening (segment 2 allows
 * hyphens — see URN_PATTERN comment below).
 *
 * Validators are compiled at module load (single AJV instance, allErrors:true,
 * strict:false — strict:false avoids draft-2020-12 keyword warnings on the
 * `contains` keyword we use; Graph organ uses strict:true with a different
 * keyword set).
 *
 * Each per-domain schema:
 *   - Pins source_category to the domain value (const)
 *   - Requires evidence_refs to be a non-empty array
 *   - Uses JSON Schema `contains` to require ≥1 evidence_refs item match the
 *     domain's source pattern (spine-transition URN, radiant URN, etc.)
 *   - Validates common gap fields (description / target_state / mission_ref /
 *     priority / severity)
 *
 * The factory pattern at lib/per-domain-analyzer-factory.js (skeleton in p4r-4,
 * full implementation in p4r-6) consumes these validators via
 * validateGapDomainSchema. The reassembly path
 * (lib/gap-analyzer.js::runPerDomainReassembly) calls validateGapDomainSchema
 * on each per-domain analyzer's output before merging into the unified gaps[]
 * Thalamus consumer contract — schema violations surface as
 * `per-domain-<domain>-failed:<msg>` degraded entries (fail-closed posture
 * per parent MP §Architectural invariants §4.6).
 */

import Ajv from 'ajv';

// Common URN shape. The relay spec cites Graph organ concept.schema.json
// (^urn:[a-zA-Z0-9._-]+:[a-zA-Z0-9_]+:.+$) verbatim, but Graph's regex was
// authored against Graph's own snake_case-only `data.type` convention; live
// Cortex URN class segments include hyphens (e.g. `spine-transition`,
// `radiant-memory`, `cortex-gap`, `minder-peer`). Segment 2 is widened to
// match the same character class as segment 1 so the regex covers actual
// Cortex usage. Per-domain EVIDENCE_PATTERNS below remain the source of
// truth for which class names a given domain accepts.
export const URN_PATTERN = '^urn:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:.+$';

// Per-domain evidence-ref source patterns. Each pattern accepts the URN
// shapes the corresponding world-state slice (cm-client / slice-clients.js)
// emits, plus textual BoR-article references for the constitutional and
// compliance domains where the LLM cites BoR raw text rather than a URN.
//
// Pattern derivation:
//   - operational: spine_state slice emits transitions referencing entity_urn
//     and transition_id. Accepts urn:*:spine-transition: / state-transition: /
//     entity: / spine-state: classes.
//   - strategic: radiant slice emits radiant-context and radiant-memory blocks
//     each carrying its own URN. Accepts urn:*:radiant: / radiant-context: /
//     radiant-memory: classes.
//   - relational: minder slice emits peer + observation URNs; hippocampus
//     emits conversation URNs. Accepts urn:*:minder: / minder-peer: /
//     minder-observation: / hippocampus: / hippocampus-conversation: classes.
//   - compliance: BoR raw-text article references (textual, e.g. "BoR §3" or
//     "BoR Article 7") OR governance-event URNs OR urn:*:bor: classes.
//   - constitutional: deepest BoR grounding — BoR article-ref textual OR
//     urn:*:bor: classes only (governance-event excluded — that's compliance).
export const EVIDENCE_PATTERNS = {
  operational:
    '^urn:[a-zA-Z0-9._-]+:(?:spine-transition|state-transition|spine-state|entity):.+$',
  strategic:
    '^urn:[a-zA-Z0-9._-]+:(?:radiant|radiant-context|radiant-memory):.+$',
  relational:
    '^urn:[a-zA-Z0-9._-]+:(?:minder|minder-peer|minder-observation|hippocampus|hippocampus-conversation):.+$',
  compliance:
    '^(?:urn:[a-zA-Z0-9._-]+:(?:bor|governance-event|governance):.+|(?:BoR|BOR|bor)\\s+(?:Article|article|art\\.?|§)\\s*\\d+.*)$',
  constitutional:
    '^(?:urn:[a-zA-Z0-9._-]+:bor:.+|(?:BoR|BOR|bor)\\s+(?:Article|article|art\\.?|§)\\s*\\d+.*)$',
};

export const GAP_DOMAINS = Object.freeze([
  'operational',
  'strategic',
  'relational',
  'compliance',
  'constitutional',
]);

function buildSchema({ sourceCategoryConst, evidencePattern }) {
  return {
    $id: `gap-${sourceCategoryConst}.schema.json`,
    type: 'object',
    required: [
      'description',
      'target_state',
      'mission_ref',
      'evidence_refs',
      'priority',
      'severity',
      'source_category',
    ],
    properties: {
      description:    { type: 'string', minLength: 1 },
      target_state:   { type: 'string', minLength: 1 },
      mission_ref:    { type: 'string', minLength: 1 },
      evidence_refs:  {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        contains: { type: 'string', pattern: evidencePattern },
      },
      priority:       { enum: ['critical', 'high', 'medium', 'low'] },
      severity:       { type: 'number', minimum: 0, maximum: 1 },
      source_category: { const: sourceCategoryConst },
    },
    // additionalProperties intentionally permissive — gap_id, analyzed_at,
    // and any per-domain analyzer metadata pass through. Thalamus consumer
    // contract preserved (output schema continuity per parent MP §4.4).
    additionalProperties: true,
  };
}

export const GAP_SCHEMAS = Object.freeze({
  operational:    buildSchema({ sourceCategoryConst: 'operational',    evidencePattern: EVIDENCE_PATTERNS.operational }),
  strategic:      buildSchema({ sourceCategoryConst: 'strategic',      evidencePattern: EVIDENCE_PATTERNS.strategic }),
  relational:     buildSchema({ sourceCategoryConst: 'relational',     evidencePattern: EVIDENCE_PATTERNS.relational }),
  compliance:     buildSchema({ sourceCategoryConst: 'compliance',     evidencePattern: EVIDENCE_PATTERNS.compliance }),
  constitutional: buildSchema({ sourceCategoryConst: 'constitutional', evidencePattern: EVIDENCE_PATTERNS.constitutional }),
});

// --- AJV validator compilation ---------------------------------------------

// strict:false avoids "strict mode: unknown keyword" complaints on $id when
// the schema is compiled directly (no $ref / no addSchema); allErrors:true
// matches Graph organ schema-validate.js posture so error reports surface
// every violation, not just the first.
const ajv = new Ajv({ allErrors: true, strict: false });

const VALIDATORS = Object.freeze(
  Object.fromEntries(GAP_DOMAINS.map(domain => [domain, ajv.compile(GAP_SCHEMAS[domain])])),
);

function formatErrors(errors) {
  return ajv.errorsText(errors, { separator: '; ', dataVar: 'gap' });
}

/**
 * Thrown by validateGap / validateGapDomainSchema on schema-validation failure.
 * The reassembly path catches this and converts to a `per-domain-<domain>-failed`
 * degraded entry (fail-closed posture per parent MP §4.6). Per-domain analyzer
 * factory consumers (p4r-6) may catch and translate to their own degraded shape.
 */
export class GapDomainSchemaError extends Error {
  constructor(domain, errors, gap, index) {
    const detail = formatErrors(errors);
    const where = (typeof index === 'number') ? `[${index}]` : '';
    super(`gap-${domain}${where} schema violation: ${detail}`);
    this.name = 'GapDomainSchemaError';
    this.domain = domain;
    this.errors = errors;
    this.gap = gap;
    if (typeof index === 'number') this.index = index;
  }
}

/**
 * Validate a single gap object against the domain-specific schema.
 * Throws GapDomainSchemaError on failure. Returns true on success.
 */
export function validateGap(domain, gap) {
  const validator = VALIDATORS[domain];
  if (!validator) {
    throw new Error(
      `Unknown gap domain: "${domain}". Expected one of: ${GAP_DOMAINS.join(', ')}`,
    );
  }
  if (validator(gap)) return true;
  throw new GapDomainSchemaError(domain, validator.errors, gap);
}

/**
 * Validate an array of gap objects against the domain-specific schema.
 * Throws GapDomainSchemaError (with index field set) on the first failing gap.
 * Returns true if all gaps pass. Empty array passes (no gaps to validate).
 */
export function validateGapDomainSchema(domain, gaps) {
  const validator = VALIDATORS[domain];
  if (!validator) {
    throw new Error(
      `Unknown gap domain: "${domain}". Expected one of: ${GAP_DOMAINS.join(', ')}`,
    );
  }
  if (!Array.isArray(gaps)) {
    throw new Error(
      `validateGapDomainSchema(${domain}, ...): gaps must be an array, got ${typeof gaps}`,
    );
  }
  for (let i = 0; i < gaps.length; i++) {
    if (!validator(gaps[i])) {
      throw new GapDomainSchemaError(domain, validator.errors, gaps[i], i);
    }
  }
  return true;
}

// Exposed for cross-module URN-shape checks (Graph organ parity).
export const URN_PATTERN_REGEX = new RegExp(URN_PATTERN);
