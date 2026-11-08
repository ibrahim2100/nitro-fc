// Unit test for tools/nitro/solver.js with a stubbed page. usage: node tools/test-nitro.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mkEl = () => ({ children: [], style: {}, _t: '', set textContent(v) { this._t = v; }, get textContent() { return this._t; },
  setAttribute() {}, appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() { doc.removed = true; } });
const attrs = {};
let checklist = [];
const doc = { body: mkEl(), createElement: mkEl, getElementById: () => null, querySelectorAll: () => checklist, documentElement: { getAttribute: (k) => (k in attrs ? attrs[k] : null) } };
const texts = (el) => [el.textContent, ...el.children.flatMap(texts)];

const lsData = {};
const ctx = {
  localStorage: { getItem: (k) => (k in lsData ? lsData[k] : null), setItem: (k, v) => { lsData[k] = String(v); } },
  document: doc, setTimeout, Promise, Map, Set, console,
  ItemPile: { STORAGE: 9 },
  UTSquadEntity: { TOTAL_PLAYERS: 23 },
  services: { SBC: { saveChallenge: () => ({ observe: (o, cb) => setTimeout(() => cb({ unobserve() {} }, { success: true }), 0) }) } },
  UTItemSearchViewModel: function () {
    this.requestActiveSquadDefIds = () => ({ observe: (o, cb) => setTimeout(() => cb({ unobserve() {} }, { success: true, data: { defIds: [1, 2, 3] } }), 0) });
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'nitro', 'solver.js'), 'utf8'), ctx);

const P = (id, rating, tradable, extra = {}) => ({ definitionId: id, rating, tradable, getStaticData: () => ({ getFullName: () => 'Player' + id }), ...extra });
let failed = 0;
const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); if (!c) failed++; };

// ---- points planner (tools/nitro/points.js)
const pctx = { Math, Float64Array, Uint8Array, Infinity, Array, globalThis: null };
pctx.globalThis = pctx;
vm.createContext(pctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'nitro', 'points.js'), 'utf8'), pctx);
const plan = pctx.__nitroPlanPoints;
{
  let f2 = 0;
  const ck = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); if (!c) f2++; };
  // exhaustive comparison on random small instances (lexicographic: coins, then penalty)
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let mism = 0;
  for (let t = 0; t < 300; t++) {
    const n = 3 + Math.floor(rnd() * 9);
    const items = Array.from({ length: n }, () => ({ score: 5 * (1 + Math.floor(rnd() * 20)), coins: rnd() < 0.5 ? 0 : 100 * Math.floor(rnd() * 8), pen: 1 + rnd() * 50 }));
    const tot = items.reduce((a, i) => a + i.score, 0);
    const target = 5 * Math.max(1, Math.floor((tot / 5) * (0.2 + rnd() * 0.7)));
    let bc = Infinity, bp = Infinity;
    for (let m = 1; m < 1 << n; m++) { let sc = 0, c = 0, p = 0; for (let i = 0; i < n; i++) if (m & (1 << i)) { sc += items[i].score; c += items[i].coins; p += items[i].pen; } if (sc >= target && (c < bc || (c === bc && p < bp - 1e-9))) { bc = c; bp = p; } }
    const r = plan(items, target);
    const pc = r.picks.reduce((a, i) => a + items[i].coins, 0), pp = r.picks.reduce((a, i) => a + items[i].pen, 0);
    if (!r.ok || pc !== bc || Math.abs(pp - bp) > 1e-6 || new Set(r.picks).size !== r.picks.length) mism++;
  }
  ck('planner equals brute force on 300 random instances', mism === 0, mism);
  ck('target already met -> empty plan', plan([{ score: 35, coins: 0, pen: 1 }], 0).picks.length === 0);
  const inf = plan([{ score: 35, coins: 0, pen: 1 }], 100);
  ck('impossible target reports shortfall', !inf.ok && inf.shortfall === 65, inf);
  // realistic club: many free low cards, few free 83s, a few priced cards
  const mk = (n, r, s, c) => Array.from({ length: n }, () => ({ rating: r, score: s, coins: c, pen: Math.pow(2, r - 60) }));
  const club = [...mk(3, 64, 20, 0), ...mk(38, 70, 35, 0), ...mk(3, 75, 90, 0), ...mk(1, 76, 100, 0), ...mk(1, 77, 120, 0), ...mk(12, 81, 280, 0), ...mk(22, 82, 340, 0), ...mk(18, 83, 410, 0), ...mk(1, 85, 2100, 0), ...mk(5, 82, 340, 700), ...mk(2, 77, 120, 3200)];
  const rp = plan(club, 2500);
  const used = rp.picks.map((i) => club[i]);
  ck('real-like club: reaches 2500 with zero coins', rp.ok && rp.coins === 0 && rp.score >= 2500, rp);
  ck('real-like club: keeps the 83s untouched when 81-82s suffice', used.every((u) => u.rating < 83), used.map((u) => u.rating));
  ck('real-like club: does not burn the free 85 (2100 pts) when many low cards exist', used.every((u) => u.rating < 85), used.map((u) => u.rating));
  ck('real-like club: overshoot below the smallest big card', rp.score - 2500 < 410, rp.score);
  // fewer players when the coin difference is small: weights include the per-player penalty
  const PEN = pctx.__nitroPlayerPenalty; // default 50
  const opt = [{ score: 2100, real: 2300 }, { score: 410, real: 700 }, ...Array.from({ length: 12 }, () => ({ score: 35, real: 200 }))];
  const mkw = (arr) => arr.map((o) => ({ score: o.score, coins: o.real + PEN, pen: 1 }));
  const p1 = plan(mkw(opt), 2510);
  const idx = p1.picks.slice().sort((a, b) => a - b);
  ck('prefers few players when it costs about the same', JSON.stringify(idx) === '[0,1]', idx);
  const cheapMany = [{ score: 2100, real: 2300 }, { score: 410, real: 2000 }, ...Array.from({ length: 12 }, () => ({ score: 35, real: 5 }))];
  const p2 = plan(mkw(cheapMany), 2510);
  ck('but still uses many players when that is much cheaper', p2.picks.length === 13 || p2.picks.length === 14, p2.picks.length);
  if (f2) process.exit(1);
}

// ---- full SBC solver (tools/nitro/sbc.js): pure parts
{
  const KEYS = { TEAM_RATING: 1, CHEMISTRY_POINTS: 2, SAME_NATION_COUNT: 3, SAME_LEAGUE_COUNT: 4, SAME_CLUB_COUNT: 5, NATION_COUNT: 6, LEAGUE_COUNT: 7, CLUB_COUNT: 8,
    NATION_ID: 9, LEAGUE_ID: 10, CLUB_ID: 11, PLAYER_MIN_OVR: 12, PLAYER_MAX_OVR: 13, PLAYER_RARITY: 14, PLAYER_QUALITY: 15, PLAYER_LEVEL: 16, PLAYER_EXACT_OVR: 17,
    PLAYER_RARITY_GROUP: 18, PLAYER_TRADABILITY: 19, FIRST_OWNER_PLAYERS_COUNT: 20 };
  const sctx = { globalThis: null, Math, Set, Map, Object, Array, Promise, setTimeout, Infinity, Date, SBCEligibilityKey: KEYS, SBCEligibilityScope: { EXACT: 0, LOWER: 1, GREATER: 2 } };
  sctx.globalThis = sctx;
  vm.createContext(sctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'nitro', 'sbc.js'), 'utf8'), sctx);
  const pure = sctx.__nitroSbcPure, search = sctx.__nitroSbcSearch;
  let f3 = 0;
  const ck = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); if (!c) f3++; };

  ck('rating: float mode matches the game on a real squad (82)', pure.teamRating([68, 83, 85, 85, 81, 84, 83, 81, 84, 82, 73], true, 11) === 82);
  ck('rating: classic mode on the same squad (83)', pure.teamRating([68, 83, 85, 85, 81, 84, 83, 81, 84, 82, 73], false, 11) === 83);
  ck('rating: uniform squad keeps its rating', pure.teamRating(new Array(11).fill(83), false, 11) === 83);
  ck('rating: float mode rounds the sum', pure.teamRating([80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 90], true, 11) === 81);

  // fake requirement objects (same interface as wrapReq)
  const mkReq = (o) => Object.assign({ canGroup: false, sameCount: false, count: -1, isLower: false, isExact: false, isGreater: true, isCombined: false, hasMultipleValues: false, satifiesRequirement: () => true, group: () => ({}) }, o);
  const grp = (f) => (items) => { const out = {}; items.forEach((x) => { (out[f(x)] = out[f(x)] || []).push(x); }); return out; };
  const it = (id, o) => Object.assign({ id, definitionId: id, rating: 70, nationId: 1, leagueId: 1, teamId: 1, rareflag: 0, preferredPosition: 14, basePossiblePositions: [14] }, o);
  const ctxE = { perItem: pure.PER_ITEM(), rating: (items) => pure.teamRating(items.map((x) => x.rating), false, items.length), chem: () => 10 };
  const six = [it(1, { leagueId: 1 }), it(2, { leagueId: 1 }), it(3, { leagueId: 2 }), it(4, { leagueId: 3 }), it(5, { leagueId: 4 }), it(6, { leagueId: 5 })];
  ck('same-league min 3: 2 are in league 1 -> short by 1', pure.reqViolation(mkReq({ keyValue: KEYS.SAME_LEAGUE_COUNT, canGroup: true, sameCount: true, count: 3, group: grp((x) => x.leagueId) }), six, ctxE) === 1);
  ck('distinct leagues min 5: 5 distinct -> ok', pure.reqViolation(mkReq({ keyValue: KEYS.LEAGUE_COUNT, canGroup: true, count: 5, group: grp((x) => x.leagueId) }), six, ctxE) === 0);
  ck('distinct clubs MAX 1: 1 club -> ok; MAX 0 -> violated', pure.reqViolation(mkReq({ keyValue: KEYS.CLUB_COUNT, canGroup: true, count: 1, isLower: true, isGreater: false, group: grp((x) => x.teamId) }), six, ctxE) === 0 &&
    pure.reqViolation(mkReq({ keyValue: KEYS.CLUB_COUNT, canGroup: true, count: 0, isLower: true, isGreater: false, group: grp((x) => x.teamId) }), six, ctxE) === 1);
  ck('team rating min 72 with 70s -> short by 2', pure.reqViolation(mkReq({ keyValue: KEYS.TEAM_RATING, value: 72 }), six, ctxE) === 2);
  ck('chemistry min 14 with 10 -> short by 4', pure.reqViolation(mkReq({ keyValue: KEYS.CHEMISTRY_POINTS, value: 14 }), six, ctxE) === 4);
  ck('min 2 players rarity 1: counts only matching cards', pure.reqViolation(mkReq({ keyValue: KEYS.PLAYER_RARITY, count: 2, value: 1, satifiesRequirement: (x) => x.rareflag === 1 }), [it(1, { rareflag: 1 }), it(2)], ctxE) === 1);
  ck('all players must be >= 70 ovr (count -1)', pure.reqViolation(mkReq({ keyValue: KEYS.PLAYER_MIN_OVR, value: 70, satifiesRequirement: (x) => x.rating >= 70 }), [it(1), it(2, { rating: 60 })], ctxE) === 1);
  // "Silver: Min. 3 Players" counts silver cards; "Player Quality: Min. Bronze" (all players) is a bound
  const tierItem = (id, tier) => it(id, { getTier: () => tier, hasQualityTiers: () => true });
  const silverReq = mkReq({ keyValue: KEYS.PLAYER_LEVEL, count: 3, value: 1, isGreater: true });
  ck('3 silver: gold cards do not count (needs exactly silver)', pure.reqViolation(silverReq, [tierItem(1, 1), tierItem(2, 1), tierItem(3, 2), tierItem(4, 2)], ctxE) === 1);
  ck('3 silver: three silver cards satisfy it', pure.reqViolation(silverReq, [tierItem(1, 1), tierItem(2, 1), tierItem(3, 1), tierItem(4, 2)], ctxE) === 0);
  ck('quality min bronze for everyone: gold passes', pure.reqViolation(mkReq({ keyValue: KEYS.PLAYER_QUALITY, count: -1, value: 0 }), [tierItem(1, 2), tierItem(2, 1)], ctxE) === 0);
  ck('quality max silver for everyone: a gold card violates', pure.reqViolation(mkReq({ keyValue: KEYS.PLAYER_QUALITY, count: -1, value: 1, isLower: true, isGreater: false }), [tierItem(1, 2), tierItem(2, 1)], ctxE) === 1);
  ck('per-player chemistry: 2 players need chem >= 3', pure.reqViolation(mkReq({ keyValue: KEYS.CHEMISTRY_POINTS, count: 2, value: 3 }), six, Object.assign({}, ctxE, { chemPoints: () => [3, 1, 0, 3, 2] })) === 0 &&
    pure.reqViolation(mkReq({ keyValue: KEYS.CHEMISTRY_POINTS, count: 3, value: 3 }), six, Object.assign({}, ctxE, { chemPoints: () => [3, 1, 0, 3, 2] })) === 1);
  ck('unknown requirement key is ignored (checked by the game later)', pure.reqViolation(mkReq({ keyValue: 999 }), six, ctxE) === 0);
  ck('cardAllowed drops cards failing an "all players" rule', !pure.cardAllowed([mkReq({ keyValue: KEYS.PLAYER_MIN_OVR, value: 70, satifiesRequirement: (x) => x.rating >= 70 })], ctxE.perItem, it(1, { rating: 60 })));

  (async () => {
    // synthetic SBC: 11 slots, same league >= 4, 5+ distinct nations, at most 6 clubs, rating >= 78
    const slotT = [0, 3, 5, 5, 7, 14, 14, 14, 12, 25, 25];
    const slots = slotT.map((t, i) => ({ index: i, typeId: t, name: 'S' + i }));
    let sd = 99; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const pool = [];
    for (let i = 0; i < 160; i++) {
      const t = slotT[Math.floor(rnd() * slotT.length)];
      const r = 60 + Math.floor(rnd() * 28);
      pool.push({ it: it(i + 1, { rating: r, leagueId: 1 + Math.floor(rnd() * 6), nationId: 1 + Math.floor(rnd() * 14), teamId: 1 + Math.floor(rnd() * 30), preferredPosition: t, basePossiblePositions: [t] }), cost: r * r * 0.4 | 0, buy: false });
    }
    const reqs = [
      mkReq({ keyValue: KEYS.SAME_LEAGUE_COUNT, canGroup: true, sameCount: true, count: 4, group: grp((x) => x.leagueId) }),
      mkReq({ keyValue: KEYS.NATION_COUNT, canGroup: true, count: 5, group: grp((x) => x.nationId) }),
      mkReq({ keyValue: KEYS.CLUB_COUNT, canGroup: true, count: 6, isLower: true, isGreater: false, group: grp((x) => x.teamId) }),
      mkReq({ keyValue: KEYS.TEAM_RATING, value: 78 }),
    ];
    const model = { slots, fixed: [], reqs, perItem: pure.PER_ITEM(), rating: (rs, n) => pure.teamRating(rs, false, n), chemOf: () => 0 };
    const res = await search(model, pool, { ms: 8000 });
    const chosen = res.assign.map((ix) => pool[ix].it);
    const v = reqs.map((r) => pure.reqViolation(r, chosen, { perItem: model.perItem, rating: (items) => model.rating(items.map((x) => x.rating), 11), chem: () => 0 }));
    ck('search: finds a squad meeting league / nation / club-max / rating', res.feasible && v.every((x) => x === 0), { v, viol: res.viol });
    ck('search: all 11 cards distinct', new Set(chosen.map((x) => x.id)).size === 11);
    // positions do not matter without a chemistry rule: the 11 cheapest valid cards win even out of position
    const allCheap = pool.map((p) => p.cost + 30 * Math.max(0, p.it.rating - 60)).sort((x, y) => x - y).slice(0, 11).reduce((x, y) => x + y, 0);
    ck('search: out-of-position cards are allowed (cost not forced up by positions)', res.cost <= allCheap * 3.2, [res.cost, allCheap]);
    const cheapReqs = [mkReq({ keyValue: KEYS.TEAM_RATING, value: 60 })];
    const relaxedRes = await search(Object.assign({}, model, { reqs: cheapReqs }), pool, { ms: 3000 });
    ck('search: with a trivial rule it picks (almost) the 11 cheapest cards', relaxedRes.feasible && relaxedRes.cost <= allCheap * 1.25, [relaxedRes.cost, allCheap]);
    // cheaper than the first feasible random squad would be: the best found must not exceed a loose bound
    const sorted = pool.map((p) => p.cost).sort((a, b) => a - b);
    const objOf = (p) => p.cost + 30 * Math.max(0, p.it.rating - 60);
    ck('search: objective is far below the average squad', res.cost < (pool.reduce((a, p) => a + objOf(p), 0) / pool.length) * 11, res.cost);
    // impossible target: best effort is returned with violations
    // equal prices: the LOWEST rated squad that satisfies the rules must win (checked against brute force)
    {
      const slots6 = [0, 1, 2, 3, 4, 5].map((i) => ({ index: i, typeId: 14, name: 'S' + i }));
      const ratings = [66, 68, 70, 72, 74, 75, 76, 78, 80, 82, 84, 86];
      const flat = ratings.map((r, i) => ({ it: it(300 + i, { rating: r, leagueId: 1, nationId: i % 3, teamId: i }), cost: 650, buy: false }));
      const m6 = { slots: slots6, fixed: [], reqs: [mkReq({ keyValue: KEYS.TEAM_RATING, value: 76 })], perItem: pure.PER_ITEM(), rating: (rs, n) => pure.teamRating(rs, false, n), chemOf: () => 0 };
      const r6 = await search(m6, flat, { ms: 4000 });
      let bestObj = Infinity;
      const pick = (start, cur) => {
        if (cur.length === 6) {
          if (pure.teamRating(cur.map((i) => ratings[i]), false, 6) >= 76) bestObj = Math.min(bestObj, cur.reduce((a, i) => a + 650 + 30 * Math.max(0, ratings[i] - 60), 0));
          return;
        }
        for (let i = start; i < ratings.length; i++) { cur.push(i); pick(i + 1, cur); cur.pop(); }
      };
      pick(0, []);
      ck('equal prices: picks the lowest-rated squad meeting the rating rule (= brute-force optimum)', r6.feasible && r6.cost === bestObj, { got: r6.cost, want: bestObj, rs: r6.assign && r6.assign.map((i) => ratings[i]) });
    }
    const hard = Object.assign({}, model, { reqs: [mkReq({ keyValue: KEYS.TEAM_RATING, value: 99 })] });
    const bad = await search(hard, pool, { ms: 1500, restarts: 3, steps: 1500 });
    ck('search: impossible target -> not feasible but best effort returned', !bad.feasible && bad.assign && bad.viol > 0, bad);
    if (f3) process.exit(1);
    runMain();
  })();
}
function runMain() {
(async () => {
  const L = ctx.__nitroLib;
  const mk = (id, rating, tradable) => P(id, rating, tradable);
  const a = mk(10, 80, true), b = mk(11, 78, true), c = mk(12, 75, false), d = mk(13, 75, true), e = mk(14, 80, true), x = mk(15, 83, false);
  ctx.document.documentElement.getAttribute = (k) => (k in attrs ? attrs[k] : null);

  check('inactive: comparator is neutral', ctx.__nitroCmp(a, b) === 0 && !ctx.__nitroBlocked(a));

  const calls = [];
  ctx.__nitroPriceFn = async (items) => { calls.push(items.map((i) => i.definitionId)); return { 10: { price: 900 }, 11: { price: 400 }, 12: { price: 650 }, 13: { price: 400 }, 15: { price: 6500 } }; };
  ctx.__nitroActive = true;
  await ctx.__nitroPrefetch([a, b, c, d, e, x, a]);
  check('prefetch asks for ALL cards incl. untradeable, unique ids', JSON.stringify(calls) === '[[10,11,12,13,14,15]]', calls);
  await ctx.__nitroPrefetch([a, b]);
  check('prefetch is cached', calls.length === 1, calls);

  check('untradeable card is valued at market price (not free)', L.cost(c) === 650 && L.cost(x) === 6500);
  check('card without price: estimated from same rating (flagged)', L.cost(e) === 900 && L.isEstimated(e) && !L.isEstimated(a), [L.cost(e), L.isEstimated(e)]);
  const sp = mk(16, 80, true); sp.rareflag = 3;
  check('special card without a price is valued x3', L.cost(sp) === 2700 && L.isEstimated(sp), L.cost(sp));
  const sorted = [a, b, c, d, e].sort(ctx.__nitroCmp).map((p) => p.definitionId);
  // 400(r75) < 400(r78) < 650 < 900(r80 priced) = 900(r80 estimated)
  check('order: lowest market value, then lowest rating', JSON.stringify(sorted.slice(0, 4)) === '[13,11,12,10]', sorted);

  // expensive players are blocked automatically (limit 5000 by default)
  check('default limit: 6500 blocked, 650 not', ctx.__nitroBlocked(x) === true && ctx.__nitroBlocked(c) === false);
  lsData['nitro:settings'] = JSON.stringify({ expensive: 0 });
  check('limit 0 disables blocking', ctx.__nitroBlocked(x) === false);
  lsData['nitro:settings'] = JSON.stringify({ expensive: 700 });
  check('custom limit from the settings page is honoured', ctx.__nitroBlocked(c) === false && ctx.__nitroBlocked(d) === false && ctx.__nitroBlocked(a) === true);
  delete lsData['nitro:settings'];

  ctx.__nitroActive = false;
  check('flag reset before solve', ctx.__nitroCmp(a, b) === 0 && !ctx.__nitroBlocked(x));

  // normal solve
  let runs = 0;
  const res = await ctx.__nitroSolve(async () => { runs++; check('active during run', ctx.__nitroActive === true); return { success: true, players: [a, b, c, d] }; });
  check('solve runs once when it succeeds', runs === 1 && res.success);
  check('flag cleared after run', ctx.__nitroActive === false);
  await new Promise((r) => setTimeout(r, 450));
  let t = texts(doc.body.children[0]).join(' | ');
  check('summary: names, total market value incl. untradeable, protected count', /Player13/.test(t) && /2,?350/.test(t) && /650/.test(t) && /23|3 لاعب/.test(t) && /غير قابلين للبيع/.test(t), t);

  check('summary has column headers and a totals row with average rating', /التقييم/.test(t) && /المجموع \(4 لاعب\)/.test(t) && /\(متوسط\)/.test(t), t);
  check('summary has a copy button', /نسخ الملخص/.test(t), t);

  // first run fails -> retry with expensive players allowed, and say so
  doc.body.children.length = 0;
  const seen = [];
  const res2 = await ctx.__nitroSolve(async () => { seen.push(ctx.__nitroBlocked(x)); return seen.length === 1 ? { success: false, reason: 'no' } : { success: true, players: [x, a] }; });
  check('retries once with the limit relaxed', seen.length === 2 && seen[0] === true && seen[1] === false && res2.success, seen);
  await new Promise((r) => setTimeout(r, 450));
  t = texts(doc.body.children[0]).join(' ');
  check('summary says expensive players had to be used', /لم يكفِ الحل بدون اللاعبين الغالين/.test(t), t);

  // failure everywhere
  doc.body.children.length = 0;
  let n = 0;
  await ctx.__nitroSolve(async () => { n++; return { success: false, reason: 'nope', players: [] }; });
  await new Promise((r) => setTimeout(r, 450));
  check('nothing found: tries club, relaxed, then unowned cards; explains', n === 3 && /ما لقيت أي تشكيلة/.test(texts(doc.body.children[0]).join(' ')), n);

  // not enough in the club, but unowned (concept) cards complete it -> tell what to buy
  doc.body.children.length = 0;
  const cp = mk(20, 82, true); cp.concept = true;
  ctx.__nitroPriceFn = async (items) => Object.fromEntries(items.map((i) => [i.definitionId, { price: i.definitionId === 20 ? 4300 : 500 }]));
  const extras = [];
  const resC = await ctx.__nitroSolve(async (extra) => { extras.push(extra && extra.includeConceptPlayers === true); return extra ? { success: true, players: [a, cp] } : { success: false, players: [a], reason: 'x' }; });
  await new Promise((r) => setTimeout(r, 450));
  t = texts(doc.body.children[0]).join(' ');
  check('falls back to unowned cards and returns that solution', resC.success && extras[extras.length - 1] === true, extras);
  check('summary lists what to buy with its price and total', /ينقصك 1 بطاقة/.test(t) && /Player20/.test(t) && /4,?300/.test(t) && /تحتاج شراء/.test(t), t);

  // nothing completes it: best effort goes into the squad and the unmet requirements are listed
  doc.body.children.length = 0;
  const placed = [];
  const chal = { squad: { getNonBrickSlots: () => [{ index: 3 }, { index: 5 }, { index: 7 }], setPlayers: (arr) => placed.push(arr) }, eligibilityRequirements: [] };
  const mkLi = (txt, done) => ({ textContent: ' ' + txt + ' ', classList: { contains: (c) => done && c === 'complete' } });
  checklist = [mkLi('Clubs in Squad: Max. 6', true), mkLi('Nationalities in Squad: Min. 5 (0)', false), mkLi('Silver: Min. 3 Players (0)', false)];
  const resP = await ctx.__nitroSolve(async () => ({ success: false, players: [a, b], reason: 'orig' }), chal);
  await new Promise((r) => setTimeout(r, 1300));
  t = texts(doc.body.children[0]).join(' | ');
  check('partial result is placed in the squad slots', placed.length === 1 && placed[0][3] === a && placed[0][5] === b && placed[0].length === 23, placed);
  check('builder gets a failure with a short Arabic reason', resP.success === false && /حل جزئي/.test(resP.reason), resP);
  check('summary lists only the unmet requirements', /حل جزئي/.test(t) && /Nationalities in Squad/.test(t) && /Silver: Min. 3/.test(t) && !/Clubs in Squad/.test(t), t);
  check('partial summary suggests buying the missing players', /اشترِ/.test(t), t);
  checklist = [];

  // ---- full solver integration (mocked engine)
  doc.body.children.length = 0;
  const cpx = mk(31, 84, true); cpx.concept = true;
  const desc = { rows: [{ cells: ['GK', 'Player10', '80', 'النادي', '900'] }, { cells: ['ST', 'Player31', '84', 'تحتاج شراء', '5,000'] }], rating: 82, chem: 21 };
  const chal2 = { squad: { getNonBrickSlots: () => [{ index: 0 }, { index: 1 }], setPlayers: (arr) => placed.push(arr) }, eligibilityRequirements: [{}, {}], isRequirementMet: (r) => r === chal2.eligibilityRequirements[0] };
  ctx.__nitroPriceFn = async (items) => Object.fromEntries(items.map((i) => [i.definitionId, { price: i.definitionId === 31 ? 5000 : 900 }]));
  ctx.__nitroSbc = { solve: async () => ({ success: true, players: [a, cpx], describe: desc, usedExpensive: false }) };
  let ranOld = 0;
  const resS = await ctx.__nitroSolve(async () => { ranOld++; return { success: false }; }, chal2);
  await new Promise((r) => setTimeout(r, 1800));
  t = texts(doc.body.children[0]).join(' | ');
  check('full solver result is returned to the builder, old engine not used', resS.success && ranOld === 0 && resS.players.length === 2, [resS, ranOld]);
  check('full solver summary: rating, chemistry, what to buy, cost', /التقييم: 82/.test(t) && /الكيميستري: 21/.test(t) && /ينقصك 1 بطاقة/.test(t) && /Player31/.test(t) && /5,?000/.test(t) && /الأولوية لناديك ثم الشراء/.test(t), t);

  doc.body.children.length = 0; placed.length = 0;
  ctx.__nitroSbc = { solve: async () => ({ success: false, players: [a, b], describe: { rows: [{ cells: ['GK', 'Player10', '80', 'النادي', '900'] }], rating: 70, chem: 5 }, usedExpensive: true }) };
  const resF = await ctx.__nitroSolve(async () => ({ success: false }), chal2);
  await new Promise((r) => setTimeout(r, 1400));
  t = texts(doc.body.children[0]).join(' | ');
  check('partial: best effort placed and requirement status shown', placed.length === 1 && placed[0][0] === a && placed[0][1] === b && /حل جزئي/.test(t) && /✅/.test(t) && /❌/.test(t), [placed.length, t]);
  check('partial: builder told it is not a full success', resF.success === false, resF);
  delete ctx.__nitroSbc;

  let threw = false;
  try { await ctx.__nitroSolve(async () => { throw new Error('x'); }); } catch { threw = true; }
  check('errors propagate and flag is cleared', threw && ctx.__nitroActive === false && !ctx.__nitroBlocked(x));
  process.exit(failed ? 1 : 0);
})();
}
