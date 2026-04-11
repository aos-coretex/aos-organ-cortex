/**
 * Cortex Graph adapter — HTTP client for the Graph organ.
 *
 * Read-only: Cortex never writes to Graph. Two operations exposed:
 *  - queryConcepts(sql, params) — used by mission-loader for active MSP lookup
 *  - getConcept(urn)            — used for direct URN resolution
 *
 * Every request carries X-Organ-Name: Cortex for Graph telemetry.
 * Uses the shared `timedFetch` helper so all outbound HTTP is abort-bounded
 * by `timeoutMs` (default 3000ms; overridable via config.graphTimeoutMs).
 * On abort, throws `GraphTimeoutError`; on other HTTP failures, throws the
 * usual `graph_query_failed` / `graph_get_concept_failed` errors. Mission
 * loader catches any of these and flags `graph-unreachable`.
 *
 * Repair #09 (2026-04-11): added abort timeout (x2p-2 O3) — prior version
 * used plain fetch() with no AbortController, so a hung Graph query would
 * stall the assessment loop.
 */

import { timedFetch } from './http-helpers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export class GraphTimeoutError extends Error {
  constructor({ url, timeoutMs }) {
    super(`graph_timeout: ${url} exceeded ${timeoutMs}ms`);
    this.name = 'GraphTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.error = 'timeout';
  }
}

export function createGraphAdapter({ graphUrl, timeoutMs = 3000 }) {
  async function queryConcepts(sql, params = []) {
    const url = `${graphUrl}/query`;
    const res = await timedFetch(url, {
      method: 'POST',
      body: { sql, params },
      timeoutMs,
    });
    if (!res.ok) {
      if (res.error === 'timeout') {
        log('cortex_graph_query_timeout', { url, timeoutMs });
        throw new GraphTimeoutError({ url, timeoutMs });
      }
      const err = new Error(`graph_query_failed: ${res.error}`);
      err.status = res.status;
      log('cortex_graph_query_error', { url, status: res.status, error: res.error });
      throw err;
    }
    return res.data;
  }

  async function getConcept(urn) {
    const encoded = encodeURIComponent(urn);
    const url = `${graphUrl}/concepts/${encoded}`;
    const res = await timedFetch(url, { method: 'GET', timeoutMs });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.error === 'timeout') {
        log('cortex_graph_get_concept_timeout', { url, timeoutMs });
        throw new GraphTimeoutError({ url, timeoutMs });
      }
      const err = new Error(`graph_get_concept_failed: ${res.error}`);
      err.status = res.status;
      throw err;
    }
    return res.data;
  }

  return { queryConcepts, getConcept };
}
