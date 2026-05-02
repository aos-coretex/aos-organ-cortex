/**
 * Per-domain prompt templates for Cortex gap analysis (p4r-6).
 *
 * Spec anchor: 50-Organs/225-Cortex/cortex-gap-analyzer-prompt-decomposition-spec.md
 *   §3.1 — per-domain output-contract (one SYSTEM_PROMPT per gap-source-category)
 *   §3.2 — per-domain mission-anchor framing (precision rudder)
 *   §3.6 — domain-specific closing instruction
 *   §7.5 — per-domain analyzer factory contract
 *
 * Five domains: operational / strategic / relational / compliance / constitutional.
 * Each SYSTEM_PROMPT pins source_category, references domain URN classes (per
 * gap-schemas EVIDENCE_PATTERNS), and preserves the constitutional-conditioning
 * boundary required by spec §4.1. The forbidden-phrase list (canonical source:
 * test/cv-scope-ruling-prompt-discipline.test.js) MUST NOT appear in any
 * per-domain SYSTEM_PROMPT, anywhere in this file, or in any buildDomainPrompt
 * output. Three-layer enforcement runs in test/cv-domain-prompt-discipline.test.js.
 */

const OUTPUT_FORMAT_BLOCK = (domainConst) =>
  `Output format (strict JSON, no prose):
{
  "gaps": [
    {
      "description": "string",
      "target_state": "string",
      "mission_ref": "string",
      "evidence_refs": ["string"],
      "priority": "critical | high | medium | low",
      "severity": 0.85,
      "source_category": "${domainConst}"
    }
  ]
}

If no ${domainConst} gaps exist, return { "gaps": [] }.`;

const BOUNDARY_BLOCK =
  `Use the BoR for constitutional conditioning that shapes how you weigh priorities. Do NOT use the BoR to adjudicate whether any specific action is allowed or prohibited — adjudication belongs to a different organ at a different stage. Your role is constitutional awareness, not adjudication. Do NOT include authorization-decision language.`;

export const OPERATIONAL_SYSTEM_PROMPT = `You are Cortex's operational gap analyzer. Your role is to identify operational gaps between the active Mission Statement Protocol (MSP) operational sections and the recent state-transition activity captured in spine-state.

You receive:
1. Mission frame — MSP raw text (focus on operational sections: SLAs, organ availability, runtime targets, cadence baselines, throughput) and BoR raw text as constitutional conditioning.
2. Spine-state slice — recent state transitions across organs (entity_urn, transition_id, timestamp, type, payload).
3. Recent goals — the last N goals already dispatched (anti-redundancy hint; do not re-emit a gap that maps to a recent goal).

${BOUNDARY_BLOCK}

Your output is a JSON array of operational gaps. Each gap MUST:
- source_category: "operational" (pinned)
- evidence_refs: at least one URN matching urn:llm-ops:spine-transition:* OR urn:llm-ops:state-transition:* OR urn:llm-ops:spine-state:* OR urn:llm-ops:entity:*
- mission_ref: a string citing the MSP operational section grounding the gap
- priority: criticality × urgency × impact
- severity: number in [0, 1]

${OUTPUT_FORMAT_BLOCK('operational')}

You do not propose HOW to close gaps — that is Thalamus's role. Identify WHAT operational state needs attention and WHY it is urgent. Focus on operational gaps in spine-transition patterns vs MSP operational requirements.`;

export const STRATEGIC_SYSTEM_PROMPT = `You are Cortex's strategic gap analyzer. Your role is to identify strategic gaps between the active Mission Statement Protocol (MSP) strategic sections and the memory/context state captured in the radiant slice.

You receive:
1. Mission frame — MSP raw text (focus on strategic sections: mission objectives, priority programs, OKRs, longer-arc goals) and BoR raw text as constitutional conditioning.
2. Radiant slice — recent context blocks, recent memory blocks, and dream-cycle stats.
3. Recent goals — the last N goals already dispatched (anti-redundancy hint; do not re-emit a gap that maps to a recent goal).

${BOUNDARY_BLOCK}

Your output is a JSON array of strategic gaps. Each gap MUST:
- source_category: "strategic" (pinned)
- evidence_refs: at least one URN matching urn:llm-ops:radiant:* OR urn:llm-ops:radiant-context:* OR urn:llm-ops:radiant-memory:*
- mission_ref: a string citing the MSP strategic section grounding the gap
- priority: criticality × urgency × impact
- severity: number in [0, 1]

${OUTPUT_FORMAT_BLOCK('strategic')}

You do not propose HOW to close gaps — that is Thalamus's role. Identify WHAT strategic alignment needs attention and WHY it matters. Focus on strategic gaps in memory/context formation, mission-attention drift, and dream-cycle health vs MSP strategic objectives.`;

export const RELATIONAL_SYSTEM_PROMPT = `You are Cortex's relational gap analyzer. Your role is to identify relational gaps between the MSP relational commitments + BoR relational principles and the person-attention activity captured in the minder and hippocampus slices.

You receive:
1. Mission frame — MSP raw text (focus on relational sections: peer commitments, person-attention coverage) and BoR raw text (relational principles + constitutional conditioning).
2. Minder slice — peer registry, recent observations.
3. Hippocampus slice — recent conversation summaries.
4. Recent goals — the last N goals already dispatched (anti-redundancy hint).

${BOUNDARY_BLOCK}

Your output is a JSON array of relational gaps. Each gap MUST:
- source_category: "relational" (pinned)
- evidence_refs: at least one URN matching urn:llm-ops:minder:* OR urn:llm-ops:minder-peer:* OR urn:llm-ops:minder-observation:* OR urn:llm-ops:hippocampus:* OR urn:llm-ops:hippocampus-conversation:*
- mission_ref: a string citing the MSP relational section or BoR relational principle grounding the gap
- priority: criticality × urgency × impact
- severity: number in [0, 1]

${OUTPUT_FORMAT_BLOCK('relational')}

You do not propose HOW to close gaps — that is Thalamus's role. Identify WHAT relational attention is missing and WHY it matters. Focus on relational gaps in person-attention coverage vs MSP relational requirements and BoR relational principles.`;

export const COMPLIANCE_SYSTEM_PROMPT = `You are Cortex's compliance gap analyzer. Your role is to identify compliance gaps between the BoR compliance articles + MSP compliance commitments and the governance-class state-transition activity captured in the governance state slice.

You receive:
1. Mission frame — BoR raw text (focus on compliance articles — read for compliance assessment, not adjudication) and MSP raw text (focus on compliance commitments).
2. Governance state slice — governance-class state transitions extracted from spine-state.
3. Recent goals — the last N goals already dispatched (anti-redundancy hint).

${BOUNDARY_BLOCK}

Your output is a JSON array of compliance gaps. Each gap MUST:
- source_category: "compliance" (pinned)
- evidence_refs: at least one URN matching urn:llm-ops:bor:* OR urn:llm-ops:governance-event:* OR urn:llm-ops:governance:* OR a textual reference matching "BoR Article N" (or BoR §N, BoR art. N)
- mission_ref: a string citing the BoR compliance article or MSP compliance section grounding the gap
- priority: criticality × urgency × impact
- severity: number in [0, 1]

${OUTPUT_FORMAT_BLOCK('compliance')}

You do not propose HOW to close gaps — that is Thalamus's role. You also do not adjudicate whether any specific governance event was correct — adjudication belongs to a different organ. Identify WHAT compliance state is misaligned with the BoR compliance articles and WHY it warrants attention. Focus on compliance gaps between governance-class events and BoR compliance articles.`;

export const CONSTITUTIONAL_SYSTEM_PROMPT = `You are Cortex's constitutional gap analyzer. Your role is to identify constitutional gaps where the organism's current activity drifts from the BoR identity articles — what the organism IS and what it must NEVER do.

You receive:
1. Mission frame — BoR raw text (focus on identity articles — what the organism is, what it must never do) and MSP raw text as background context.
2. (No additional world-state slice — constitutional analysis reasons from BoR identity articles alone, with mission-frame as the only operational signal.)
3. Recent goals — the last N goals already dispatched (anti-redundancy hint).

${BOUNDARY_BLOCK}

Your output is a JSON array of constitutional gaps. Each gap MUST:
- source_category: "constitutional" (pinned)
- evidence_refs: at least one URN matching urn:llm-ops:bor:* OR a textual reference matching "BoR Article N" (or BoR §N, BoR art. N)
- mission_ref: a string citing the BoR identity article grounding the gap
- priority: criticality × urgency × impact
- severity: number in [0, 1]

${OUTPUT_FORMAT_BLOCK('constitutional')}

You do not propose HOW to close gaps — that is Thalamus's role. You do NOT adjudicate whether any past or future action is allowed — adjudication belongs to a different organ. Identify WHAT identity drift exists between the organism's recent goal-stream and the BoR identity articles, and WHY it matters. Focus on constitutional gaps where the organism's current activity conflicts with BoR identity articles.`;

export const DOMAIN_SYSTEM_PROMPTS = Object.freeze({
  operational: OPERATIONAL_SYSTEM_PROMPT,
  strategic: STRATEGIC_SYSTEM_PROMPT,
  relational: RELATIONAL_SYSTEM_PROMPT,
  compliance: COMPLIANCE_SYSTEM_PROMPT,
  constitutional: CONSTITUTIONAL_SYSTEM_PROMPT,
});

/**
 * Per-domain mission-anchor metadata. Each anchor biases which MSP / BoR
 * sections the per-domain prompt emphasizes. Spec §3.2 calls this the
 * "precision rudder" — short framing sentences that point the LLM at the
 * most-relevant mission sections for THIS slice.
 *
 * Shape:
 *   { msp_focus, bor_role, slice_label, closing_focus }
 *
 * msp_focus      — short phrase used in the user-content header
 * bor_role       — how this domain reads BoR (always conditioning, never
 *                  adjudication)
 * slice_label    — human-readable name for the world-state slice this domain
 *                  consumes
 * closing_focus  — domain-specific closing instruction (spec §3.6)
 */
export const MISSION_ANCHORS = Object.freeze({
  operational: Object.freeze({
    msp_focus: 'operational sections — SLAs, organ availability, runtime targets, cadence baselines',
    bor_role: 'constitutional conditioning shaping operational priorities',
    slice_label: 'Spine-State Slice — recent state transitions across organs',
    closing_focus: 'operational gaps in spine-transition patterns vs MSP operational requirements',
  }),
  strategic: Object.freeze({
    msp_focus: 'strategic sections — mission objectives, priority programs, OKRs, longer-arc goals',
    bor_role: 'constitutional conditioning shaping strategic priorities',
    slice_label: 'Radiant Slice — recent context blocks, recent memory blocks, dream stats',
    closing_focus: 'strategic gaps in memory/context formation and dream-cycle health vs MSP strategic objectives',
  }),
  relational: Object.freeze({
    msp_focus: 'relational sections — peer commitments, person-attention coverage',
    bor_role: 'BoR relational principles and constitutional conditioning',
    slice_label: 'Minder + Hippocampus Slices — peer registry, observations, recent conversation summaries',
    closing_focus: 'relational gaps in person-attention coverage vs MSP relational requirements and BoR relational principles',
  }),
  compliance: Object.freeze({
    msp_focus: 'compliance sections — operational compliance commitments',
    bor_role: 'BoR compliance articles — governance constraints (read for compliance assessment, not adjudication)',
    slice_label: 'Governance State Slice — governance-class state transitions extracted from spine',
    closing_focus: 'compliance gaps between governance-class events and BoR compliance articles',
  }),
  constitutional: Object.freeze({
    msp_focus: '(constitutional analyzer focuses primarily on BoR identity articles; MSP referenced only for cross-context)',
    bor_role: 'BoR identity articles — what the organism IS and what it must NEVER do',
    slice_label: '(none — constitutional analyzer reasons from BoR alone)',
    closing_focus: "constitutional gaps where the organism's recent goal-stream conflicts with BoR identity articles",
  }),
});

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

function safePriority(p) {
  return VALID_PRIORITIES.includes(p) ? p : 'medium';
}

function safeSeverity(s) {
  if (typeof s !== 'number' || Number.isNaN(s)) return 0.5;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

function safeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => typeof x === 'string' && x.length > 0);
}

/**
 * Build the per-domain prompt.
 *
 * @param {object}   args
 * @param {string}   args.domain         - one of operational | strategic | relational | compliance | constitutional
 * @param {object}   args.missionFrame   - { msp: { raw_text }, bor: string | { raw_text } }
 * @param {object}   args.slice          - the per-domain world-state slice (DOMAIN_SLICE_FETCHERS output)
 * @param {Array}    [args.recentGoals]  - last N goals already dispatched (defaults to [])
 * @param {object}   [args.missionAnchor] - MISSION_ANCHORS[domain]; defaults to MISSION_ANCHORS[domain] if omitted
 * @returns {{messages: Array, options: {system: string}}}
 *
 * Caller (per-domain factory) layers correlationId onto options before
 * passing to llm.chat — see lib/per-domain-analyzer-factory.js.
 */
export function buildDomainPrompt({ domain, missionFrame, slice, recentGoals, missionAnchor } = {}) {
  if (!domain || !DOMAIN_SYSTEM_PROMPTS[domain]) {
    throw new Error(`buildDomainPrompt: unknown domain "${domain}"`);
  }
  const anchor = missionAnchor || MISSION_ANCHORS[domain];
  const mf = missionFrame || {};
  const msp = (mf.msp && typeof mf.msp.raw_text === 'string') ? mf.msp.raw_text : '';
  const bor = typeof mf.bor === 'string'
    ? mf.bor
    : (mf.bor && typeof mf.bor.raw_text === 'string' ? mf.bor.raw_text : '');
  const goals = Array.isArray(recentGoals) ? recentGoals : [];
  const sliceJson = JSON.stringify(slice ?? {}, null, 2);
  const goalsJson = JSON.stringify(goals, null, 2);

  const userContent = `# Mission Frame (focus: ${anchor.msp_focus})

## MSP — active version

${msp}

---

## BoR — ${anchor.bor_role}

${bor}

---

# ${anchor.slice_label}

\`\`\`json
${sliceJson}
\`\`\`

---

# Recent Goals (last dispatched — anti-redundancy hint)

\`\`\`json
${goalsJson}
\`\`\`

---

Identify the ${domain} gaps. Ground each gap in a specific MSP section or BoR article. Prioritize by criticality × urgency × impact. Output the strict JSON schema described in your system instructions. If no ${domain} gaps exist, return { "gaps": [] }. Do not propose how to close gaps — identify WHAT ${domain} attention is needed and WHY. Focus on ${anchor.closing_focus}.`;

  return {
    messages: [{ role: 'user', content: userContent }],
    options: { system: DOMAIN_SYSTEM_PROMPTS[domain] },
  };
}

/**
 * Parse the LLM response for a per-domain analyzer call.
 *
 * Returns the gaps array on success; throws Error on parse failure or
 * missing gaps[] (relay p4r-6 contract — caller catches and converts to
 * `per-domain-${domain}-parse-failed` degraded entry).
 *
 * Defensive normalization for priority / severity / evidence_refs (safe
 * fallbacks) — but does NOT coerce source_category. The downstream
 * validateGapDomainSchema enforces source_category === domain; if the
 * LLM produced a domain mismatch, the schema check rejects (degraded).
 *
 * @param {object} response - the llm.chat() return value (expected: { content })
 * @param {string} domain   - the per-domain analyzer's domain (used in error messages)
 * @returns {Array} gaps[]
 * @throws {Error} on null/empty/non-JSON content or missing gaps[]
 */
export function parseDomainResponse(response, domain) {
  const content = response && typeof response.content === 'string' ? response.content : null;
  if (!content || content.trim().length === 0) {
    throw new Error(`empty-response`);
  }

  let stripped = content.trim();
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`invalid-json:${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.gaps)) {
    throw new Error(`missing-gaps-array`);
  }

  return parsed.gaps.map((g, idx) => ({
    description: typeof g?.description === 'string' ? g.description : '',
    target_state: typeof g?.target_state === 'string' ? g.target_state : '',
    mission_ref: typeof g?.mission_ref === 'string' ? g.mission_ref : '',
    evidence_refs: safeStringArray(g?.evidence_refs),
    priority: safePriority(g?.priority),
    severity: safeSeverity(g?.severity),
    source_category: typeof g?.source_category === 'string' ? g.source_category : domain,
    _originalIndex: idx,
  }));
}
