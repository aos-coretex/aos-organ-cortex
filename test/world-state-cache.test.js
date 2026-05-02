/**
 * world-state-cache unit tests — verify cache layer authored in p4r-3.
 *
 * Storage is pure: no log, no emit; only assertions on get/set/invalidate/peek.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorldStateCache } from '../lib/world-state-cache.js';

test('get returns hit:false on missing key', () => {
  const cache = createWorldStateCache();
  const r = cache.get('radiant');
  assert.equal(r.hit, false);
  assert.equal(r.value, null);
  assert.equal(r.age_ms, 0);
  assert.equal(r.expires_in_ms, 0);
});

test('set then get returns hit:true with value', () => {
  const cache = createWorldStateCache();
  cache.set('minder', { peers: [1, 2, 3] }, 60000);
  const r = cache.get('minder');
  assert.equal(r.hit, true);
  assert.deepEqual(r.value, { peers: [1, 2, 3] });
  assert.ok(r.age_ms >= 0 && r.age_ms < 100, 'age_ms should be recent');
  assert.ok(r.expires_in_ms > 59000 && r.expires_in_ms <= 60000, 'expires_in_ms reflects TTL');
});

test('expired entries are evicted and reported as miss', async () => {
  const cache = createWorldStateCache();
  cache.set('hippo', { conv: 'x' }, 5); // 5ms TTL
  await new Promise(r => setTimeout(r, 20));
  const r = cache.get('hippo');
  assert.equal(r.hit, false);
  assert.equal(r.expired, true);
  // Re-get after eviction returns standard miss shape (no expired flag)
  const r2 = cache.get('hippo');
  assert.equal(r2.hit, false);
  assert.equal(r2.expired, undefined);
});

test('invalidate removes a single slice', () => {
  const cache = createWorldStateCache();
  cache.set('radiant', 'r', 60000);
  cache.set('minder', 'm', 60000);
  cache.invalidate('radiant');
  assert.equal(cache.get('radiant').hit, false);
  assert.equal(cache.get('minder').hit, true);
});

test('invalidateAll clears every slice', () => {
  const cache = createWorldStateCache();
  cache.set('radiant', 'r', 60000);
  cache.set('minder', 'm', 60000);
  cache.set('hippo', 'h', 60000);
  cache.invalidateAll();
  assert.equal(cache.get('radiant').hit, false);
  assert.equal(cache.get('minder').hit, false);
  assert.equal(cache.get('hippo').hit, false);
});

test('peek surfaces every slice with hit metadata; live entries report hit:true', () => {
  const cache = createWorldStateCache();
  cache.set('radiant', 'r', 60000);
  cache.set('minder', 'm', 60000);
  const peek = cache.peek();
  assert.ok(peek.radiant);
  assert.ok(peek.minder);
  assert.equal(peek.radiant.hit, true);
  assert.equal(peek.minder.hit, true);
  assert.ok(peek.radiant.age_ms >= 0);
  assert.ok(peek.radiant.expires_in_ms > 0);
});

test('default TTL applies when ttlMs omitted', () => {
  const cache = createWorldStateCache({ defaultTtlMs: 12345 });
  cache.set('radiant', 'r'); // no explicit ttl
  const r = cache.get('radiant');
  assert.equal(r.hit, true);
  assert.ok(r.expires_in_ms > 12000 && r.expires_in_ms <= 12345);
});

test('per-call TTL overrides default', () => {
  const cache = createWorldStateCache({ defaultTtlMs: 12345 });
  cache.set('radiant', 'r', 99999);
  const r = cache.get('radiant');
  assert.ok(r.expires_in_ms > 99000 && r.expires_in_ms <= 99999, 'per-call ttl wins');
});

test('set on existing slice replaces value + extends TTL', async () => {
  const cache = createWorldStateCache();
  cache.set('radiant', 'old', 5);
  await new Promise(r => setTimeout(r, 1));
  cache.set('radiant', 'new', 60000);
  const r = cache.get('radiant');
  assert.equal(r.value, 'new');
  assert.ok(r.expires_in_ms > 50000);
});
