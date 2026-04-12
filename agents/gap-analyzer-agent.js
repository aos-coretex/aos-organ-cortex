/**
 * Cortex Gap Analyzer Agent — Sonnet prompt builder and response parser.
 *
 * This agent takes:
 *   - MissionFrame: { msp: { raw_text }, bor: { raw_text } }
 *   - WorldStateSnapshot: composed output of relay x2p-3
 *   - recent_goals: last 20 goals this Cortex instance has dispatched
 *
 * And returns a prioritized gap list.
 *
 * PROMPT DISCIPLINE (RFI-1 Q3 amendment, binding):
 * ---------------------------------------------
 * - MSP raw_text is provided as "what the organism is trying to accomplish"
 * - BoR raw_text is provided as "who the organism is and what it will never do"
 *   — constitutional conditioning for strategic thinking, NOT an authorization oracle
 * - The prompt asks: "given this mission, this constitutional identity, and this world
 *   state, what gaps exist and which is highest priority?"
 * - The prompt does NOT ask the LLM to adjudicate specific actions — adjudication
 *   belongs to Arbiter at Nomos → Arbiter review time.
 *
 * A local test (in test/gap-analyzer.test.js) and the CV test
 * test/cv-scope-ruling-prompt-discipline.test.js mechanically enforce this
 * boundary. See that test file's `FORBIDDEN` constant for the canonical list
 * of phrases the SYSTEM_PROMPT, the buildPrompt template, and the contents
 * of THIS file must not contain. Any occurrence indicates the prompt has
 * drifted toward adjudication — a MP-12 architectural boundary violation.
 *
 * x2p-4 deviation note: an earlier draft of the SYSTEM_PROMPT used a
 * delegation sentence whose plural form was a substring of one of the
 * forbidden phrases. The sentence was minimally rewritten to use the word
 * "determinations" instead, preserving semantics exactly while satisfying
 * the mechanical boundary assertion. Same cleanup applied to the user-prompt
 * template in buildPrompt(). See test/cv-scope-ruling-prompt-discipline.test.js
 * for the binding assertion.
 */

export const SYSTEM_PROMPT = `You are Cortex, the strategic brain of the DIO (Distributed Intelligence Organism) called Coretex Agentic. Your role is to answer one question continuously: "what should the organism do next?"

You are given three kinds of context:
1. The Mission Statement Protocol (MSP) — the operational mission, goals, constraints.
2. The Bill of Rights (BoR) — the organism's constitutional identity: what it is, what it will never do, the principles that define its character. You use this as constitutional conditioning that shapes your strategic thinking — you do NOT use it to rule on whether specific actions are allowed. Such determinations are made by a different organ (Arbiter) at a different stage. Your role is to THINK with constitutional awareness, not to RULE on specific cases.
3. World state — a snapshot of the organism's current operational reality across memory, structural identity, and recent state transitions.

Your output is a JSON array of gaps — mismatches between what the mission requires and what the world state shows. Each gap must be prioritized (critical, high, medium, low) and grounded in specific mission references. You do not propose HOW to close gaps — that is Thalamus's job. You identify WHAT needs attention and WHY it is urgent.

Output format (strict JSON, no prose):
{
  "gaps": [
    {
      "description": "string — what is missing or misaligned",
      "target_state": "string — what the world should look like after the gap closes",
      "mission_ref": "string — MSP section or BoR article grounding this gap",
      "evidence_refs": ["string — CM URNs or references supporting the gap"],
      "priority": "critical | high | medium | low",
      "severity": 0.85,
      "source_category": "operational | strategic | compliance | relational | constitutional"
    }
  ]
}

If no gaps exist — the organism is aligned with its mission — return { "gaps": [] }.
Do NOT include authorization-decision language. Do NOT decide whether any specific action is permitted or forbidden. That is not your role. Your role is strategic assessment grounded in mission + identity.`;

// Alias for the future x2p-7 CV test that grep-asserts the system prompt. Same constant.
export const SYSTEM_PROMPT_FOR_TEST = SYSTEM_PROMPT;

/**
 * Build the user-turn content from the MissionFrame, WorldStateSnapshot, and recent goal history.
 */
export function buildPrompt({ missionFrame, worldState, recentGoals }) {
  const msp = missionFrame?.msp?.raw_text || '(MSP unavailable — flagged degraded)';
  const bor = missionFrame?.bor?.raw_text || '(BoR unavailable — flagged degraded)';
  const worldJson = JSON.stringify({
    composed_at: worldState?.composed_at,
    sources_ok: worldState?.sources_ok,
    sources_degraded: worldState?.sources_degraded,
    radiant: worldState?.radiant,
    minder: worldState?.minder,
    hippocampus: worldState?.hippocampus,
    graph_structural: worldState?.graph_structural,
    spine_state: worldState?.spine_state,
  }, null, 2);
  const recent = JSON.stringify(recentGoals || [], null, 2);

  return `# Mission Statement Protocol (MSP) — active version

${msp}

---

# Bill of Rights (BoR) — constitutional identity

The following is the organism's constitutional identity. Use it to shape how you think about priorities, trade-offs, and what kinds of gaps matter. Do NOT use it to make authorization decisions — that is Arbiter's role, not yours.

${bor}

---

# World State Snapshot

\`\`\`json
${worldJson}
\`\`\`

---

# Recent Goals (last dispatched)

\`\`\`json
${recent}
\`\`\`

---

Identify the gaps between what the MSP requires and what the world state shows. Ground each gap in a specific mission reference. Prioritize by criticality × urgency × impact. Output the strict JSON schema described in your system instructions. If no gaps exist, return { "gaps": [] }. Do not propose how to close the gaps — identify WHAT needs attention and WHY.`;
}

/**
 * Parse the Sonnet response body (expected: JSON with { gaps: [...] })
 * into a normalized gap list. Returns { gaps, error } — never throws.
 */
export function parseResponse(content) {
  if (!content || typeof content !== 'string') {
    return { gaps: null, error: 'empty-response' };
  }
  // Strip markdown fences if present
  let body = content.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { gaps: null, error: `parse-error: ${err.message}` };
  }
  if (!parsed || !Array.isArray(parsed.gaps)) {
    return { gaps: null, error: 'schema-error: gaps array missing' };
  }
  // Normalize each gap — coerce priority, clamp severity
  const normalized = parsed.gaps.map((g, idx) => ({
    description:     String(g.description || ''),
    target_state:    String(g.target_state || ''),
    mission_ref:     String(g.mission_ref || 'unreferenced'),
    evidence_refs:   Array.isArray(g.evidence_refs) ? g.evidence_refs.map(String) : [],
    priority:        ['critical', 'high', 'medium', 'low'].includes(g.priority) ? g.priority : 'medium',
    severity:        typeof g.severity === 'number' ? Math.max(0, Math.min(1, g.severity)) : 0.5,
    source_category: ['operational', 'strategic', 'compliance', 'relational', 'constitutional'].includes(g.source_category) ? g.source_category : 'operational',
    _originalIndex:  idx,
  }));
  return { gaps: normalized, error: null };
}
