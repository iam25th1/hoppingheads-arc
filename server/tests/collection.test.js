/**
 * Contract for the salvaged map generator and collection rules.
 *
 * Doubles as the written record of what generateMap() takes and returns,
 * since phase 1 wires it into the socket lobby.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, isInRange, THEME_KEYS, RARITY_TABLE } from '../src/game/mapGenerator.js';
import {
  createCollector, discover, beginMint, finishMint, contestMint,
  scoreCollector, rankCollectors, visibleAssets,
  DISCOVERY_RADIUS, CONTEST_RADIUS, MINT_DURATIONS, MINT_LIMIT, SPEED_BONUS_WINDOW,
} from '../src/game/collection.js';

const SEED = '0x8f3a1c2e9b7d4f60aa11bb22cc33dd44ee55ff6600112233445566778899aabb';

// -- generateMap contract -------------------------------------------

test('generateMap: same seed and theme give the same map', () => {
  assert.deepEqual(generateMap(SEED, 'forest-relics'), generateMap(SEED, 'forest-relics'));
});

test('generateMap: only the first 8 hex chars of the seed matter', () => {
  // seedFromHex() truncates. Phase 1 must know this before choosing a seed
  // format, otherwise two seeds that differ past char 8 collide.
  const a = generateMap('0x8f3a1c2e' + '0'.repeat(56), 'forest-relics');
  const b = generateMap('0x8f3a1c2e' + 'f'.repeat(56), 'forest-relics');
  assert.deepEqual({ ...a, seed: null }, { ...b, seed: null });
});

test('generateMap: different seeds give different maps', () => {
  const a = generateMap('0x00000001', 'forest-relics');
  const b = generateMap('0x00000002', 'forest-relics');
  assert.notDeepEqual(a.assets.map((x) => [x.x, x.y]), b.assets.map((x) => [x.x, x.y]));
});

test('generateMap: theme is picked from the seed when not overridden', () => {
  const m = generateMap(SEED);
  assert.ok(THEME_KEYS.includes(m.theme));
  assert.equal(generateMap(SEED).theme, m.theme);
});

test('generateMap: rejects an unknown theme', () => {
  assert.throws(() => generateMap(SEED, 'not-a-theme'), /Unknown theme/);
});

test('generateMap: output shape', () => {
  const m = generateMap(SEED, 'city-objects');
  assert.equal(m.seed, SEED);
  assert.equal(m.theme, 'city-objects');
  assert.equal(m.mapWidth, 960);
  assert.equal(m.mapHeight, 600);
  assert.equal(m.tileSize, 16);
  for (const key of ['zones', 'paths', 'trees', 'structures', 'water', 'assets']) {
    assert.ok(Array.isArray(m[key]), `${key} is an array`);
  }
  assert.equal(m.assetCount, m.assets.length);
  assert.ok(m.assetCount >= 15 && m.assetCount <= 25, `asset count ${m.assetCount} in 15..25`);
  const a = m.assets[0];
  assert.deepEqual(Object.keys(a).sort(), [
    'discovered', 'discoveredBy', 'index', 'minted', 'mintedBy', 'name',
    'points', 'rarity', 'rarityName', 'themeTag', 'tokenId', 'x', 'y',
  ]);
  assert.equal(a.index, 0);
  assert.ok(a.rarity >= 0 && a.rarity <= 4);
  assert.equal(a.points, RARITY_TABLE[a.rarity].points);
  assert.ok(a.x >= 40 && a.x <= 920 && a.y >= 40 && a.y <= 560, 'asset placed away from the edges');
});

test('isInRange is inclusive at the radius', () => {
  assert.equal(isInRange(0, 0, 3, 4, 5), true);
  assert.equal(isInRange(0, 0, 3, 4, 4.99), false);
});

// -- collection rules -----------------------------------------------

function fixture() {
  const map = generateMap(SEED, 'enchanted-ruins');
  const asset = map.assets[0];
  const player = createCollector(asset.x, asset.y);
  return { map, asset, player };
}

test('discover: marks assets in radius, once, by actor', () => {
  const { map, asset, player } = fixture();
  const found = discover(map, player, 'alice', 1000);
  assert.ok(found.includes(asset));
  assert.equal(asset.discovered, true);
  assert.equal(asset.discoveredBy, 'alice');
  assert.equal(asset.discoveryTime, 1000);
  assert.ok(player.discoveredAssets.includes(asset.index));
  // Second pass finds nothing new
  assert.deepEqual(discover(map, player, 'alice', 1001), []);
});

test('discover: nothing outside the radius', () => {
  const { map, asset } = fixture();
  const far = createCollector(asset.x + DISCOVERY_RADIUS + 1, asset.y);
  const found = discover(map, far, 'bob', 0);
  assert.ok(!found.includes(asset));
});

test('beginMint: refuses undiscovered, taken, distant and over limit', () => {
  const { map, asset, player } = fixture();
  assert.equal(beginMint(map, player, 'alice', asset.index, 0).error, 'Asset not discovered yet');
  discover(map, player, 'alice', 0);

  const far = createCollector(asset.x + DISCOVERY_RADIUS + 1, asset.y);
  far.discoveredAssets.push(asset.index);
  assert.equal(beginMint(map, far, 'bob', asset.index, 0).error, 'Too far from asset');

  assert.equal(beginMint(map, player, 'alice', 999, 0).error, 'Asset not found');

  const capped = createCollector(asset.x, asset.y);
  capped.mintedAssets = new Array(MINT_LIMIT).fill({});
  assert.equal(beginMint(map, capped, 'carol', asset.index, 0).error, 'Mint limit reached');

  asset.minted = true;
  assert.equal(beginMint(map, player, 'alice', asset.index, 0).error, 'Asset already minted');
});

test('beginMint: locks the player and reports speed bonus eligibility', () => {
  const { map, asset, player } = fixture();
  discover(map, player, 'alice', 1000);
  const r = beginMint(map, player, 'alice', asset.index, 1000 + SPEED_BONUS_WINDOW);
  assert.equal(r.ok, true);
  assert.equal(r.duration, MINT_DURATIONS[asset.rarity]);
  assert.equal(r.endTime, 1000 + SPEED_BONUS_WINDOW + r.duration);
  assert.equal(r.isSpeedBonus, true);
  assert.equal(player.state, 'minting');
  assert.equal(beginMint(map, player, 'alice', asset.index, 5000).error, 'Already minting');
});

test('beginMint: no speed bonus for a late or foreign mint', () => {
  const { map, asset, player } = fixture();
  discover(map, player, 'alice', 1000);
  assert.equal(beginMint(map, player, 'alice', asset.index, 1000 + SPEED_BONUS_WINDOW + 1).isSpeedBonus, false);

  const { map: m2, asset: a2, player: p2 } = fixture();
  discover(m2, p2, 'alice', 1000);
  const other = createCollector(a2.x, a2.y);
  assert.equal(beginMint(m2, other, 'bob', a2.index, 1000).isSpeedBonus, false);
});

test('finishMint: waits for the duration, then awards points once', () => {
  const { map, asset, player } = fixture();
  discover(map, player, 'alice', 0);
  const start = beginMint(map, player, 'alice', asset.index, 0);
  assert.equal(finishMint(map, player, 'alice', start.endTime - 101).error, 'Mint not finished');

  const done = finishMint(map, player, 'alice', start.endTime);
  assert.equal(done.ok, true);
  assert.equal(done.asset, asset);
  assert.equal(done.points, Math.floor(asset.points * 1.2), 'speed bonus applied');
  assert.equal(done.totalScore, done.points);
  assert.equal(asset.minted, true);
  assert.equal(asset.mintedBy, 'alice');
  assert.equal(player.state, 'idle');
  assert.equal(player.speedBonuses, 1);
  assert.equal(finishMint(map, player, 'alice', start.endTime + 1).error, 'Not minting');
});

test('finishMint: base points without the speed bonus', () => {
  const { map, asset, player } = fixture();
  discover(map, player, 'alice', 0);
  const late = SPEED_BONUS_WINDOW + MINT_DURATIONS[asset.rarity] + 1;
  const start = beginMint(map, player, 'alice', asset.index, late);
  const done = finishMint(map, player, 'alice', start.endTime);
  assert.equal(done.points, asset.points);
  assert.equal(player.speedBonuses, 0);
});

test('finishMint: asset taken mid lock clears the lock and awards nothing', () => {
  const { map, asset, player } = fixture();
  discover(map, player, 'alice', 0);
  const start = beginMint(map, player, 'alice', asset.index, 0);
  asset.minted = true;
  asset.mintedBy = 'bob';
  const r = finishMint(map, player, 'alice', start.endTime);
  assert.equal(r.ok, false);
  assert.equal(player.state, 'idle');
  assert.equal(player.mintProgress, null);
  assert.equal(player.score, 0);
});

test('contestMint: needs proximity and a matching mint in progress', () => {
  const { map, asset, player } = fixture();
  discover(map, player, 'alice', 0);
  beginMint(map, player, 'alice', asset.index, 0);

  const far = createCollector(asset.x + CONTEST_RADIUS + 1, asset.y);
  assert.equal(contestMint(far, player, asset.index).error, 'Too far to contest');

  const near = createCollector(asset.x + 1, asset.y);
  assert.equal(contestMint(near, player, asset.index + 1).error, 'Target not minting this asset');

  const r = contestMint(near, player, asset.index);
  assert.equal(r.ok, true);
  assert.equal(player.state, 'idle');
  assert.equal(player.mintProgress, null);
  assert.equal(asset.minted, false, 'the asset stays on the map');
});

test('scoreCollector: set bonus at three of one tag, plus discovery credit', () => {
  const p = createCollector();
  p.score = 100;
  p.discoveredAssets = [1, 2, 3, 4];
  p.mintedAssets = [{ themeTag: 'arcane' }, { themeTag: 'arcane' }, { themeTag: 'nature' }];
  assert.deepEqual(scoreCollector(p), {
    baseScore: 100, setBonus: 1, activeSets: [], discoveryCredit: 20, speedBonuses: 0,
    finalScore: 120, mintedCount: 3, discoveredCount: 4,
  });
  p.mintedAssets.push({ themeTag: 'arcane' });
  const s = scoreCollector(p);
  assert.equal(s.setBonus, 1.5);
  assert.deepEqual(s.activeSets, [{ tag: 'arcane', count: 3 }]);
  assert.equal(s.finalScore, 150 + 20);
});

test('rankCollectors: sorts by final score and assigns placement', () => {
  const a = createCollector(); a.score = 10;
  const b = createCollector(); b.score = 30;
  const c = createCollector(); c.score = 20;
  const r = rankCollectors([{ id: 'a', player: a }, { id: 'b', player: b }, { id: 'c', player: c }]);
  assert.deepEqual(r.map((x) => [x.id, x.placement]), [['b', 1], ['c', 2], ['a', 3]]);
});

test('visibleAssets: fog of war hides undiscovered assets', () => {
  const { map, asset, player } = fixture();
  assert.deepEqual(visibleAssets(map), []);
  discover(map, player, 'alice', 0);
  const v = visibleAssets(map);
  assert.ok(v.length >= 1);
  assert.equal(v[0].index, asset.index);
  assert.deepEqual(Object.keys(v[0]).sort(), [
    'discoveredBy', 'index', 'minted', 'mintedBy', 'name', 'rarity', 'rarityName', 'themeTag', 'x', 'y',
  ]);
});
