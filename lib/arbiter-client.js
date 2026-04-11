/**
 * Cortex Arbiter client — HTTP read-only for BoR raw text.
 *
 * Depends on the parallel repair task that adds `GET /bor/raw` to Arbiter
 * (see auto-prompt-repairs/2026-04-11 repair-agent-arbiter-bor-raw-endpoint.md).
 * If that endpoint is missing (404) or Arbiter is down, this client returns
 * null and the mission loader flags the assessment as BoR-degraded.
 *
 * Cortex reads BoR as constitutional context for strategic thinking — not as
 * a scope oracle. Scope rulings remain Arbiter's exclusive domain at Nomos →
 * Arbiter adjudication time. See RFI-1 Q3 amendment.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createArbiterClient({ arbiterUrl, timeoutMs = 5000 }) {
  async function getBoRRaw() {
    const url = `${arbiterUrl}/bor/raw`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Organ-Name': 'Cortex' },
        signal: controller.signal,
      });
      if (res.status === 503) {
        log('cortex_arbiter_bor_unavailable', { reason: 'BOR_NOT_LOADED' });
        return null;
      }
      if (res.status === 404) {
        log('cortex_arbiter_bor_endpoint_missing', { url, note: 'repair-agent-arbiter-bor-raw-endpoint has not landed' });
        return null;
      }
      if (!res.ok) {
        log('cortex_arbiter_bor_error', { status: res.status });
        return null;
      }
      const data = await res.json();
      return {
        version: data.version,
        hash: data.hash,
        raw_text: data.raw_text,
        effective_since: data.effective_since,
        loaded_at: data.loaded_at,
      };
    } catch (err) {
      log('cortex_arbiter_bor_fetch_error', { error: err.name === 'AbortError' ? 'timeout' : err.message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { getBoRRaw };
}
