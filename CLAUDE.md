# Cortex Organ (#225)

## Identity

- **Organ:** Cortex (Strategic Brain / Autonomous Assessment Loop)
- **Number:** 225
- **Profile:** Probabilistic
- **Artifact:** logic (no database; no persistent state)
- **DIO Node:** Strategic brain
- **Ports:** 4040 (AOS) / 3940 (SAAS)
- **Binding:** 127.0.0.1

## Role

Cortex is the organ that makes the DIO proactive. Without Cortex, the DIO only reacts to human requests via Receptor. With Cortex, the DIO pursues its mission autonomously — continuously observing world state, comparing to mission (MSP + BoR), identifying gaps, and generating high-level goals for Thalamus to operationalize.

Cortex answers **"what should the organism do next?"** Thalamus answers **"how should this be done?"** Nomos answers **"is this allowed?"** Arbiter answers **"is this within the BoR?"** Cerberus executes. This separation prevents a god organ.

## Boundary (binding)

- **Cortex is strictly OTM** (per `dio-architectural-conclusions.md` §1). Cortex produces and consumes only OTM messages. Cortex NEVER produces APM, PEM, ATM, or HOM. Cortex NEVER interacts with Nomos, Cerberus, or Arbiter to draft APs, submit authorization requests, or issue tokens.
- **Cortex does NOT rule on BoR scope.** Cortex reads BoR raw text as *constitutional conditioning* for its LLM gap analysis — strategic thinking shaped by institutional identity. Scope rulings (IN_SCOPE / OUT_OF_SCOPE / AMBIGUOUS on specific APs) are Arbiter's exclusive job at Nomos → Arbiter adjudication time. See RFI-1 Q3 amendment for the read/rule distinction.
- **Cortex does NOT write to Collective Memory.** Goals are published as OTMs to Thalamus, which creates the corresponding JobRecords in spine-state.

## Dependencies

| Organ | AOS Port | Purpose | Hardness |
|---|---|---|---|
| Spine | 4000 | Message bus (WebSocket + HTTP) — goal emission, broadcast subscriptions, state event audit trail | hard |
| Graph | 4020 | MSP concept read (`msp_version`), state event trail query | soft (degraded: pause assessment loop if unreachable) |
| Arbiter | 4021 | BoR raw text via `GET /bor/raw` | soft (degraded: BoR frame absent, assessment proceeds with MSP only + flagged) |
| Radiant | 4006 | CM query — context + memory blocks | soft |
| Minder | 4007 | CM query — person observations | soft |
| Hippocampus | 4008 | CM query — recent conversation summaries | soft |
| Thalamus | 4041 | Goal consumer (OTM target). MP-13 will build real Thalamus; MP-12 CV tests use a mock fixture. | soft (goals queued and retried) |

**`createOrgan` dependencies list:** `['Spine']` only. Graph / Arbiter / Radiant / Minder / Hippocampus / Thalamus are all soft — probed at boot but Cortex proceeds with degraded flags set if any are unreachable. If spine-state (events endpoint) is unreachable, the assessment loop pauses.

## Key Modules

- `@coretex/organ-boot` — boot factory (`createOrgan`)
- `@coretex/organ-boot/urn` — URN generation (`urn:llm-ops:<ns>:<ts>-<rand>`)
- `@coretex/organ-boot/spine-client` — Spine WebSocket + HTTP client
- `@coretex/organ-boot/llm-client` — Sonnet client for gap analysis
- `lib/assessment-loop.js` — self-regulating cadence engine (THIS relay)
- `lib/mission-loader.js` — MSP + BoR raw-text reader with change invalidation (relay x2p-2)
- `lib/cm-client.js` — direct HTTP CM query composer with partial-failure flagging (relay x2p-3)
- `lib/gap-analyzer.js` — Sonnet gap identification and prioritization (relay x2p-4)
- `lib/goal-emitter.js` — structured goal builder + directed OTM dispatch to Thalamus (relay x2p-5)
- `handlers/spine-commands.js` — directed OTM handler (relay x2p-6)
- `handlers/broadcast.js` — broadcast handler (governance version updates, mailbox_pressure) (relay x2p-6)

## Architecture

Cortex runs a continuous assessment loop. The loop is NOT a cron schedule. It is a self-regulating control loop whose interval adjusts based on gap density and downstream backpressure.

**Assessment cycle (6 steps per iteration):**
1. Read mission (MSP raw text + BoR raw text + cached metadata).
2. Read world state (direct HTTP queries to Radiant, Minder, Hippocampus, Graph, Spine events endpoint; compose with partial-failure flagging).
3. Identify gaps (Sonnet prompt fed MSP + BoR + world state + recent goal history).
4. Prioritize gaps (LLM ordering by criticality × urgency × impact).
5. Generate goal for the top-priority gap (structured envelope).
6. Emit directed OTM → Thalamus with the goal payload.

**Cadence self-regulation:**
- Floor: 30 seconds (`CORTEX_LOOP_FLOOR_MS`)
- Ceiling: 15 minutes (`CORTEX_LOOP_CEILING_MS`)
- Start: 5 minutes (`CORTEX_LOOP_START_MS`)
- Gap found → `next = max(floor, current / 2)`
- No gap found → `next = min(ceiling, current * 1.5)`
- `mailbox_pressure` on Thalamus → `next = min(ceiling, current * 2)` (doubling)

**First iteration runs immediately** at `onStartup` — not via an initial `setTimeout(assess, startMs)`. Cortex is awake the moment its HTTP server and Spine WebSocket are ready.

**Manual trigger:** `POST /assessment/trigger` bypasses the cadence and runs one immediate cycle. Does NOT disrupt the scheduled cadence — the next automatic iteration still fires at the previously-computed `next_interval`.

## Running

```bash
npm install                 # Install dependencies
npm test                    # Run unit tests (no Spine required)
CORTEX_PORT=4040 npm start  # Start organ (requires Spine; all CM deps soft)
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith packages
- Never read BoR file directly from disk — always via Arbiter `GET /bor/raw`
- Never produce APM / PEM / ATM / HOM — Cortex is strictly OTM
- Never write to Graph / Radiant / Minder / Hippocampus — Cortex is read-only on CM; goals are the only output and they go to Thalamus

## Conventions

- ES modules (import/export)
- Node.js built-in test runner (`node --test`)
- Structured JSON logging to stdout
- Express 5 (via organ-shared-lib)
- `/opt/homebrew/bin/node` in LaunchAgent (bug #6)
- LaunchAgent `RunAtLoad: false` (bug #7)
- `createLLMClient(configObject)` direct call with `agentName`/`defaultModel`/`defaultProvider`/`apiKeyEnvVar`/`maxTokens` (bug #8)
- `healthCheck` / `introspectCheck` return flat objects (bug #9)

## Completed Relays

- Relay 1 (x2p-1): Project scaffold + self-regulating assessment-loop engine (pure, 13 unit tests) + 4 stub interface files (mission-loader, cm-client, gap-analyzer, goal-emitter). Server/index.js is a stub — full boot lands in x2p-6.
