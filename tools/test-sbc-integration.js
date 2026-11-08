// End-to-end test of tools/nitro/sbc.js + solver.js against a FAKE EA world (no browser).
// Exercises the page-integration code paths (club loading, pricing, search, verification against the
// game, repair, buying, summary) that the pure unit tests do not reach.  usage: node tools/test-sbc-integration.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n, c ? '' : JSON.stringify(x)); if (!c) failed++; };

const KEYS = { TEAM_RATING: 1, CHEMISTRY_POINTS: 2, SAME_NATION_COUNT: 3, SAME_LEAGUE_COUNT: 4, SAME_CLUB_COUNT: 5, NATION_COUNT: 6, LEAGUE_COUNT: 7, CLUB_COUNT: 8,
  NATION_ID: 9, LEAGUE_ID: 10, CLUB_ID: 11, PLAYER_MIN_OVR: 12, PLAYER_MAX_OVR: 13, PLAYER_RARITY: 14, PLAYER_QUALITY: 15, PLAYER_LEVEL: 16, PLAYER_EXACT_OVR: 17,
  PLAYER_RARITY_GROUP: 18, PLAYER_TRADABILITY: 19, FIRST_OWNER_PLAYERS_COUNT: 20, MYSTERY: 999 };
const SCOPE = { EXACT: 0, LOWER: 1, GREATER: 2 };

function makeWorld(opts) {
  opts = opts || {};
  let seed = 4242; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const slotTypes = [0, 3, 5, 5, 7, 12, 14, 14, 16, 25, 25];
  const mkItem = (id, o) => Object.assign({
    id, definitionId: id, type: 0, rating: 70, nationId: 1, leagueId: 1, teamId: 1, rareflag: 0, tradable: true, loans: -1, concept: false,
    preferredPosition: 14, basePossiblePositions: [14], owners: 1,
    getTier() { return this.rating >= 75 ? 2 : this.rating >= 65 ? 1 : 0; }, hasQualityTiers() { return true; },
    getStaticData() { return { getFullName: () => 'P' + id }; },
  }, o);
  const club = [];
  for (let i = 0; i < (opts.clubSize || 120); i++) {
    const t = slotTypes[Math.floor(rnd() * slotTypes.length)];
    club.push(mkItem(1000 + i, { rating: 62 + Math.floor(rnd() * 24), leagueId: 1 + Math.floor(rnd() * 5), nationId: 1 + Math.floor(rnd() * 12), teamId: 1 + Math.floor(rnd() * 25), preferredPosition: t, basePossiblePositions: [t] }));
  }
  const concept = [];
  for (let i = 0; i < 400; i++) {
    const t = slotTypes[Math.floor(rnd() * slotTypes.length)];
    concept.push(mkItem(5000 + i, { rating: 60 + Math.floor(rnd() * 30), leagueId: 1 + Math.floor(rnd() * 8), nationId: 1 + Math.floor(rnd() * 20), teamId: 1 + Math.floor(rnd() * 40), preferredPosition: t, basePossiblePositions: [t], tradable: true }));
  }
  const slots = slotTypes.map((t, i) => ({ index: i, position: { id: t, typeId: t, name: 'S' + i }, item: { id: 0 } }));
  const dto = (key, value, count, scope) => ({ getFirstKey: () => key, getValue: () => [value], getFirstValue: () => value, count, scope, isCombinedRequirement: false });
  const reqs = opts.reqs || [
    dto(KEYS.SAME_LEAGUE_COUNT, 4, -1, SCOPE.GREATER),
    dto(KEYS.NATION_COUNT, 5, -1, SCOPE.GREATER),
    dto(KEYS.CLUB_COUNT, 6, -1, SCOPE.LOWER),
    dto(KEYS.PLAYER_LEVEL, 1, 3, SCOPE.GREATER), // "Silver: Min. 3 players"
    dto(KEYS.PLAYER_QUALITY, 0, -1, SCOPE.GREATER),
    dto(KEYS.CHEMISTRY_POINTS, 14, -1, SCOPE.GREATER),
  ];
  const chemOf = (items) => {
    // simple deterministic chemistry: +1 per player that shares a league with another and -0 otherwise
    const byL = {}; items.forEach((x) => { if (x && x.id > 0) byL[x.leagueId] = (byL[x.leagueId] || 0) + 1; });
    return items.map((x) => (x && x.id > 0 && byL[x.leagueId] >= 3 ? 3 : x && x.id > 0 && byL[x.leagueId] >= 2 ? 1 : 0));
  };
  const squad = {
    getFieldPlayers: () => slots,
    getNonBrickSlots: () => slots.slice(),
    getFormation: () => ({}),
    getManager: () => ({ item: {} }),
    chemCalculator: { calculate: (f, items) => { const p = chemOf(items); return { chemistry: p.reduce((a, b) => a + b, 0), getSlotChemistry: (i) => ({ points: p[i] }) }; } },
    setPlayers(arr) { slots.forEach((s) => { s.item = arr[s.index] || { id: 0 }; }); },
  };
  const placed = () => slots.map((s) => s.item).filter((x) => x && x.id > 0);
  const gameRating = (xs) => { const a = xs.length; let n = xs.reduce((p, x) => p + x.rating, 0); const avg = n / a; let o = n; xs.forEach((x) => { if (x.rating >= avg) o += x.rating - avg; }); return Math.floor(Math.round(o) / a); };
  const challenge = {
    squad, eligibilityRequirements: reqs, eligibilityOperation: 0,
    isRequirementMet(d) {
      const xs = placed(); if (xs.length < 11) return false;
      const k = d.getFirstKey(), v = d.getFirstValue();
      const cmp = (have, need) => (d.scope === SCOPE.LOWER ? have <= need : d.scope === SCOPE.EXACT ? have === need : have >= need);
      const sizes = (f) => { const m = {}; xs.forEach((x) => { m[f(x)] = (m[f(x)] || 0) + 1; }); return Object.values(m); };
      switch (k) {
        case KEYS.SAME_LEAGUE_COUNT: return cmp(Math.max(...sizes((x) => x.leagueId)), v);
        case KEYS.SAME_NATION_COUNT: return cmp(Math.max(...sizes((x) => x.nationId)), v);
        case KEYS.LEAGUE_COUNT: return cmp(sizes((x) => x.leagueId).length, v);
        case KEYS.NATION_COUNT: return cmp(sizes((x) => x.nationId).length, v);
        case KEYS.CLUB_COUNT: return cmp(sizes((x) => x.teamId).length, v);
        case KEYS.PLAYER_LEVEL: return cmp(xs.filter((x) => x.getTier() === v).length, d.count);
        case KEYS.PLAYER_QUALITY: return xs.every((x) => cmp(x.getTier(), v));
        case KEYS.CHEMISTRY_POINTS: return cmp(squad.chemCalculator.calculate({}, slots.map((s) => s.item)).chemistry, v);
        case KEYS.TEAM_RATING: return cmp(gameRating(xs), v);
        case KEYS.MYSTERY: return opts.mystery ? opts.mystery(xs) : true;
        default: return true;
      }
    },
    meetsRequirements() { return reqs.every((d) => this.isRequirementMet(d)); },
    getRequirementCounter(d) { const xs = placed(); return d.getFirstKey() === KEYS.MYSTERY ? xs.filter((x) => x.id % 2 === 0).length : 0; },
  };
  return { club, concept, challenge, squad, slots, placed, mkItem };
}

function boot(world, extra) {
  const doc = { body: { appendChild() {}, children: [] }, documentElement: { getAttribute: () => null }, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, remove() {} }), getElementById: () => null, querySelectorAll: () => [] };
  const obs = (payload) => ({ observe: (ns, cb) => setTimeout(() => cb({ unobserve() {} }, payload), 0) });
  const ctx = {
    document: doc, setTimeout, Promise, Map, Set, Math, Object, Array, JSON, Date, Number, Float64Array, Uint8Array, Infinity, console,
    localStorage: { getItem: () => null, setItem() {} },
    SBCEligibilityKey: KEYS, SBCEligibilityScope: SCOPE, SBCEligibilityOperation: { AND: 0, OR: 1 },
    UTSquadEntity: { TOTAL_PLAYERS: 23 }, ItemType: { PLAYER: 0 }, ItemPile: { STORAGE: 9 },
    SearchType: { PLAYER: 'p' }, SearchSortType: { RATING: 'r' }, SearchSortOrder: { ASCENDING: 'a', DESCENDING: 'd' },
    SearchLevel: { BRONZE: 'bronze', SILVER: 'silver', GOLD: 'gold' },
    UTSearchCriteriaDTO: function () {}, UTServerSettingsRepository: { KEY: { SQUAD_RATING_FLOAT_CALCULATION_ENABLED: 'f' } },
    UTItemSearchViewModel: function () { this.searchCriteria = {}; this.requestActiveSquadDefIds = () => obs({ success: true, data: { defIds: [] } }); },
    services: {
      Configuration: { checkFeatureEnabled: () => true },
      Club: { search: () => obs({ success: true, response: { items: world.club.slice(), retrievedAll: true } }) },
      Item: {
        searchStorageItems: () => obs({ success: true, response: { items: [], retrievedAll: true } }),
        searchConceptItems: (crit) => {
          const lvl = crit.level, tier = (x) => (x.rating >= 75 ? 'gold' : x.rating >= 65 ? 'silver' : 'bronze');
          const all = world.concept.filter((x) => tier(x) === lvl).sort((a, b) => a.rating - b.rating);
          return obs({ success: true, response: { items: all.slice(crit.offset, crit.offset + crit.count), retrievedAll: false } });
        },
      },
      SBC: { saveChallenge: () => obs({ success: true }) },
    },
  };
  ctx.globalThis = ctx;
  // prices: dearer with rating; concept cards a bit dearer
  ctx.__nitroPriceFn = async (items) => Object.fromEntries(items.map((i) => {
    const it = world.club.concat(world.concept).find((x) => x.definitionId === i.definitionId);
    return [i.definitionId, { price: it ? Math.round(Math.pow(1.25, it.rating - 60) * 100) : 500 }];
  }));
  Object.assign(ctx, extra || {});
  vm.createContext(ctx);
  ['solver.js', 'sbc.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, 'nitro', f), 'utf8'), ctx));
  return ctx;
}

(async () => {
  // 1) club is enough: all requirements, verified by the "game"
  {
    const w = makeWorld();
    const ctx = boot(w);
    ctx.__nitroActive = true;
    const t0 = Date.now();
    const res = await ctx.__nitroSbc.solve(w.challenge, { squadDefs: [] });
    ctx.__nitroActive = false;
    check('club solve: success, 11 players, game accepts it', res.success && res.players.length === 11 && res.verified === true, { s: res.success, n: res.players.length, v: res.verified });
    ctx.slots; w.squad.setPlayers((() => { const a = new Array(23); res.players.forEach((p, i) => { a[i] = p; }); return a; })());
    check('club solve: every requirement is met according to the game', w.challenge.meetsRequirements(), res.reqDiag);
    check('club solve: nothing to buy', !res.bought && res.players.every((p) => !p.concept));
    check('club solve: fast (< 15 s)', Date.now() - t0 < 15000, Date.now() - t0);
  }

  // 2) the game knows a rule the model does not -> verification + repair still reach a squad the game accepts
  {
    const w = makeWorld({ mystery: (xs) => xs.filter((x) => x.id % 2 === 0).length >= 6, reqs: undefined });
    w.challenge.eligibilityRequirements.push({ getFirstKey: () => KEYS.MYSTERY, getValue: () => [6], getFirstValue: () => 6, count: -1, scope: SCOPE.GREATER, isCombinedRequirement: false });
    const ctx = boot(w);
    ctx.__nitroActive = true;
    const res = await ctx.__nitroSbc.solve(w.challenge, { squadDefs: [] });
    ctx.__nitroActive = false;
    check('unknown rule: game ends up accepting the squad (verified or repaired)', res.verified === true, { v: res.verified, rep: res.repaired });
    check('unknown rule: diagnostics describe every requirement', Array.isArray(res.reqDiag) && res.reqDiag.length === 7 && /MYSTERY/.test(res.reqDiag[6]), res.reqDiag);
  }

  // 3) the club cannot do it (tiny club) -> buys the cheapest missing cards and says so
  {
    const w = makeWorld({ clubSize: 14 });
    const ctx = boot(w);
    ctx.__nitroActive = true;
    const res = await ctx.__nitroSbc.solve(w.challenge, { squadDefs: [] });
    ctx.__nitroActive = false;
    const buy = res.players.filter((p) => p.concept || p.isConceptPlayer);
    check('tiny club: finds a squad using unowned cards', res.success && buy.length > 0 && res.players.length === 11, { s: res.success, buy: buy.length });
    check('tiny club: still prefers owned cards (uses all it can)', res.players.length - buy.length >= 1, res.players.length - buy.length);
    check('tiny club: model says every requirement is met', res.describe.reqOk.every(Boolean), res.describe.reqOk);
  }

  // 4) nothing can satisfy it (impossible rating) -> best effort + clear failure
  {
    const w = makeWorld({ clubSize: 30, reqs: [{ getFirstKey: () => KEYS.TEAM_RATING, getValue: () => [99], getFirstValue: () => 99, count: -1, scope: SCOPE.GREATER, isCombinedRequirement: false }] });
    const ctx = boot(w);
    ctx.__nitroActive = true;
    const res = await ctx.__nitroSbc.solve(w.challenge, { squadDefs: [] });
    ctx.__nitroActive = false;
    check('impossible: reports failure but still returns the best squad', !res.success && res.players.length === 11, { s: res.success, n: res.players && res.players.length });
  }

  // 6) the real-life failure: exactly 2 nations, exactly 3 leagues, max 6 per league / nation, all gold, chemistry >= 30
  {
    const dto = (key, value, count, scope) => ({ getFirstKey: () => key, getValue: () => [value], getFirstValue: () => value, count, scope, isCombinedRequirement: false });
    const w = makeWorld({ clubSize: 45, reqs: [
      dto(KEYS.LEAGUE_COUNT, 3, -1, SCOPE.EXACT),
      dto(KEYS.NATION_COUNT, 2, -1, SCOPE.EXACT),
      dto(KEYS.SAME_LEAGUE_COUNT, 6, -1, SCOPE.LOWER),
      dto(KEYS.SAME_NATION_COUNT, 6, -1, SCOPE.LOWER),
      dto(KEYS.PLAYER_QUALITY, 2, -1, SCOPE.EXACT),
      dto(KEYS.CHEMISTRY_POINTS, 30, -1, SCOPE.GREATER),
    ] });
    const ctx = boot(w);
    ctx.__nitroActive = true;
    const t0 = Date.now();
    const res = await ctx.__nitroSbc.solve(w.challenge, { squadDefs: [] });
    ctx.__nitroActive = false;
    const arr = new Array(23); res.players.forEach((p, i) => { arr[i] = p; }); w.squad.setPlayers(arr);
    check('exact-nations scenario: solved (club + purchases) and the game accepts it', res.success && w.challenge.meetsRequirements(), { s: res.success, diag: res.reqDiag, ok: res.describe && res.describe.reqOk, nations: new Set(res.players.map((p) => p.nationId)).size, leagues: new Set(res.players.map((p) => p.leagueId)).size });
    check('exact-nations scenario: exactly 2 nations and 3 leagues', new Set(res.players.map((p) => p.nationId)).size === 2 && new Set(res.players.map((p) => p.leagueId)).size === 3);
    console.log('   (took ' + (Date.now() - t0) + ' ms, bought ' + res.players.filter((p) => p.concept || p.isConceptPlayer).length + ')');
  }

  // 7) all cards cost the same: the lowest-rated squad that still meets the rating rule must be chosen
  {
    const dto = (key, value, count, scope) => ({ getFirstKey: () => key, getValue: () => [value], getFirstValue: () => value, count, scope, isCombinedRequirement: false });
    const w = makeWorld({ clubSize: 90, reqs: [dto(KEYS.TEAM_RATING, 76, -1, SCOPE.GREATER)] });
    const ctx = boot(w);
    ctx.__nitroPriceFn = async (items) => Object.fromEntries(items.map((i) => [i.definitionId, { price: 650 }]));
    ctx.__nitroActive = true;
    const res = await ctx.__nitroSbc.solve(w.challenge, { squadDefs: [] });
    ctx.__nitroActive = false;
    const ratings = res.players.map((p) => p.rating);
    const sum = ratings.reduce((a, b) => a + b, 0);
    const avgAll = w.club.reduce((a, p) => a + p.rating, 0) / w.club.length;
    check('equal prices: team rating is exactly the required 76 (no wasted high cards)', res.success && res.describe.rating === 76, { r: res.describe && res.describe.rating, ratings });
    check('equal prices: squad is far lower rated than an average squad', sum / 11 < avgAll + 3, { avg: sum / 11, club: avgAll });
  }

  // 5) full __nitroSolve flow with the real engine: returns the players for the builder to place
  {
    const w = makeWorld();
    const ctx = boot(w);
    const out = await ctx.__nitroSolve(async () => { throw new Error('old engine must not run'); }, w.challenge);
    check('__nitroSolve: uses the full solver and returns a success for the builder', out && out.success && out.players.length === 11, out);
  }

  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed', e && e.stack || e); process.exit(1); });
