/**
 * Scope-ruling prompt discipline — RFI-1 Q3 amendment mechanical enforcement.
 *
 * BINDING. Enforces the architectural boundary that Cortex reads BoR as
 * constitutional context but NEVER makes scope rulings. Any future change
 * that introduces scope-ruling language into the Sonnet prompt template
 * will fail this test.
 *
 * Three-layer enforcement:
 *   1. SYSTEM_PROMPT exported constant (case-insensitive substring check)
 *   2. agents/gap-analyzer-agent.js file content (catches docstring drift)
 *   3. buildPrompt() output with a sample MissionFrame + WorldStateSnapshot
 *
 * If this test fails, the prompt has drifted toward adjudication and must
 * be corrected before the relay executor can mark the organ as active.
 *
 * Convention for future maintainers of agents/gap-analyzer-agent.js:
 *   - Do not name the forbidden phrases inline in the file. Reference this
 *     test (and its FORBIDDEN constant) as the canonical list.
 *   - The agent file's docstring already follows this convention — see the
 *     x2p-7 cleanup that removed the inline phrase enumeration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, buildPrompt } from '../agents/gap-analyzer-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FORBIDDEN = [
  'in_scope',
  'out_of_scope',
  'ambiguous',
  'scope ruling',
  'scope gate',
  'permitted action',
  'forbidden action',
  'IN_SCOPE',
  'OUT_OF_SCOPE',
  'AMBIGUOUS',
];

test('SYSTEM_PROMPT does not contain scope-ruling language', () => {
  const lowered = SYSTEM_PROMPT.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !lowered.includes(phrase.toLowerCase()),
      `SYSTEM_PROMPT contains forbidden phrase: "${phrase}"`,
    );
  }
});

test('agents/gap-analyzer-agent.js file content does not contain scope-ruling language', async () => {
  const agentPath = join(__dirname, '..', 'agents', 'gap-analyzer-agent.js');
  const content = await readFile(agentPath, 'utf-8');
  const lowered = content.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !lowered.includes(phrase.toLowerCase()),
      `gap-analyzer-agent.js contains forbidden phrase: "${phrase}". The agent file must reference test/cv-scope-ruling-prompt-discipline.test.js::FORBIDDEN by reference, not by inline enumeration.`,
    );
  }
});

test('buildPrompt output does not contain scope-ruling language', () => {
  const sampleMission = {
    msp: { version: '1.0.0', raw_text: '# MSP\n\n## Purpose\nA clean mission with no forbidden phrases.' },
    bor: { version: '1.0.0', raw_text: '# BoR\n\n## Article 1\nIdentity description without forbidden language.' },
  };
  const sampleWorld = {
    sources_ok: ['Radiant'],
    sources_degraded: [],
    spine_state: { recent_transitions: [] },
    radiant: null,
    minder: null,
    hippocampus: null,
    graph_structural: null,
  };
  const prompt = buildPrompt({
    missionFrame: sampleMission,
    worldState: sampleWorld,
    recentGoals: [],
  });
  const lowered = prompt.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !lowered.includes(phrase.toLowerCase()),
      `buildPrompt output contains forbidden phrase: "${phrase}"`,
    );
  }
});
