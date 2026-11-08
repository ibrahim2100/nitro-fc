// Nitro full SBC solver (normal squad challenges). Replaces the builder's greedy engine, which
// ignores chemistry and "max" requirements and gives up with a partial squad.
//   - understands every requirement the game shows: team rating, total chemistry, same/distinct
//     nation-league-club counts (min / max / exact), rarity, quality, ovr limits, specific ids...
//   - chemistry comes from the game's own calculator, rating from the game's own formula
//   - search = simulated annealing over the free slots; minimises coins (market value), and out of
//     position cards cost a little
//   - order of preference: your club (without expensive cards) -> your club (with them) -> buy the
//     fewest / cheapest missing cards (unowned "concept" cards priced from fut.gg)
// All evaluation helpers are pure so tools/test-nitro.js can test them in Node.
(function () {
  var VIOL_W = 100000; // one unit of requirement violation outweighs any amount of coins
  var OOP_COST = 0; // positions only matter through chemistry (the game's calculator decides); cheapest wins otherwise
  var BUY_FACTOR = 2; // real coins spent on buying count double (club cards are valued at market price but cost nothing out of pocket)
  var RATING_W = 30; // coins-equivalent per rating point above 60: among equally priced cards the lowest rated wins
  var K = function () { return globalThis.SBCEligibilityKey || {}; };

  // ---------- pure helpers ----------
  function teamRating(ratings, floatMode, size) {
    var a = size || ratings.length || 1, n = 0, i;
    for (i = 0; i < ratings.length; i++) n += ratings[i];
    var r;
    if (floatMode) {
      var avg = Math.min(n / a, 99), o = n;
      for (i = 0; i < ratings.length; i++) if (ratings[i] >= avg) o += ratings[i] - avg;
      n = Math.round(o);
    } else {
      r = Math.min(Math.floor(n / a), 99);
      for (i = 0; i < ratings.length; i++) if (ratings[i] >= r) n += ratings[i] - r;
    }
    return Math.min(Math.max(Math.floor(n / a), 0), 99);
  }

  function fitsSlot(it, typeId) {
    if (it.preferredPosition === typeId) return true;
    var b = it.basePossiblePositions;
    return !!b && b.indexOf(typeId) !== -1;
  }

  var PER_ITEM = function () {
    var k = K();
    var o = {};
    ['CLUB_ID', 'FIRST_OWNER_PLAYERS_COUNT', 'LEAGUE_ID', 'NATION_ID', 'PLAYER_EXACT_OVR', 'PLAYER_LEVEL', 'PLAYER_QUALITY',
      'PLAYER_MAX_OVR', 'PLAYER_MIN_OVR', 'PLAYER_RARITY', 'PLAYER_RARITY_GROUP', 'PLAYER_TRADABILITY'].forEach(function (n) { if (k[n] !== undefined) o[k[n]] = true; });
    return o;
  };

  function compare(r, have, need) {
    if (r.isLower) return Math.max(0, have - need);
    if (r.isExact) return Math.abs(have - need);
    return Math.max(0, need - have);
  }
  var linkedCache = new Map();
  function clubKey(x) {
    var t = x.teamId;
    if (linkedCache.has(t)) return linkedCache.get(t);
    var v = t;
    try { var l = globalThis.repositories.TeamConfig.getLinkedTeam(t); if (l !== undefined && l !== null) v = l; } catch (e) { /* no team config: plain team id */ }
    linkedCache.set(t, v);
    return v;
  }
  function attrVal(x, attr) { return attr === 'teamId' ? clubKey(x) : x[attr]; }
  function tierOf(it) { try { return it.getTier(); } catch (e) { return -1; } }
  function satisfies(r, it) {
    var k = K();
    if (r.keyValue === k.PLAYER_QUALITY || r.keyValue === k.PLAYER_LEVEL) {
      var hasTier = true;
      try { hasTier = !!it.hasQualityTiers(); } catch (e) { hasTier = true; }
      var t = hasTier ? tierOf(it) : 2; // cards without tiers (specials) count as gold
      var v = r.value;
      // "Silver: Min. 3 players" counts cards that ARE silver; "Player Quality: Min. Bronze" (all players) is a bound
      if (r.count > 0) return hasTier && t === v;
      return r.isLower ? t <= v : r.isExact ? t === v : t >= v;
    }
    return !!r.satifiesRequirement(it);
  }

  // How far a set of cards is from satisfying one requirement (0 = satisfied).
  function reqViolation(r, items, ctx) {
    var k = K();
    if (r.keyValue === k.TEAM_RATING) return compare(r, ctx.rating(items), r.value);
    if (r.keyValue === k.CHEMISTRY_POINTS) {
      if (r.count > 0 && ctx.chemPoints) { // "N players with at least X chemistry"
        var pts = ctx.chemPoints(), ok = 0;
        for (var pi = 0; pi < pts.length; pi++) if (pts[pi] >= r.value) ok++;
        return compare(r, ok, r.count);
      }
      return compare(r, ctx.chem(), r.value);
    }
    if (k.ALL_PLAYERS_CHEMISTRY_POINTS !== undefined && r.keyValue === k.ALL_PLAYERS_CHEMISTRY_POINTS && ctx.chemPoints) {
      var cp = ctx.chemPoints(), bad = 0;
      for (var ci = 0; ci < cp.length; ci++) {
        var okc = r.isLower ? cp[ci] <= r.value : r.isExact ? cp[ci] === r.value : cp[ci] >= r.value;
        if (!okc) bad++;
      }
      return bad;
    }
    if (r.canGroup) {
      var groups = r.group(items) || {};
      var sizes = Object.keys(groups).map(function (g) { return groups[g].length; });
      var have = r.sameCount ? (sizes.length ? Math.max.apply(null, sizes) : 0) : sizes.length;
      return compare(r, have, r.count);
    }
    if (r.isCombined || !ctx.perItem[r.keyValue]) return 0; // unknown / combined: checked against the game at the end
    var sat = 0;
    for (var i = 0; i < items.length; i++) if (satisfies(r, items[i])) sat++;
    if (r.count === -1) return items.length - sat;
    return compare(r, sat, r.count);
  }

  // A card can ever be used only if it satisfies every "all players must ..." requirement.
  function cardAllowed(reqs, perItem, it) {
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (r.count === -1 && perItem[r.keyValue] && !r.isCombined && !satisfies(r, it)) return false;
    }
    return true;
  }

  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // model: {slots:[{index,typeId}], fixed:[items], reqs, perItem, rating(ratings,size), chemOf(placed,slots)->number}
  // pool: [{it, cost, buy}]  ->  {feasible, viol, cost, assign, alts}
  // Simulated annealing over the free slots. The weight of a violation grows during the run (so the search can
  // cross infeasible regions early and is strict at the end); moves are either random or "cohesive"
  // (a card sharing nation / league / club with a card already chosen), which is what exact / max / chemistry
  // rules need.
  async function searchCore(model, pool, opts) {
    opts = opts || {};
    var n = model.slots.length, P = pool.length;
    if (P < n) return { feasible: false, viol: Infinity, cost: Infinity, assign: null, alts: [] };
    var rnd = mulberry(opts.seed || 12345);
    var fits = model.slots.map(function (s) {
      var f = [];
      for (var i = 0; i < P; i++) if (fitsSlot(pool[i].it, s.typeId)) f.push(i);
      return f;
    });
    var groups = [new Map(), new Map(), new Map()];
    var attrOf = [function (x) { return x.nationId; }, function (x) { return x.leagueId; }, clubKey];
    pool.forEach(function (p, i) {
      groups.forEach(function (g, gi) {
        var k = attrOf[gi](p.it);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(i);
      });
    });
    var ctxBase = { perItem: model.perItem };
    var fixedItems = model.fixed || [];
    var sizeAll = n + fixedItems.length;

    function evaluate(assign) {
      var placed = assign.map(function (ix) { return pool[ix].it; });
      var all = placed.concat(fixedItems);
      var chemCache = null;
      var ctx = {
        perItem: ctxBase.perItem,
        rating: function (items) { return model.rating(items.map(function (x) { return x.rating; }), sizeAll); },
        chem: function () {
          if (chemCache === null) chemCache = model.chemOf(placed, model.slots);
          return chemCache;
        },
        chemPoints: model.chemPointsOf ? function () { return model.chemPointsOf(placed, model.slots); } : null,
      };
      var viol = 0;
      for (var i = 0; i < model.reqs.length; i++) viol += reqViolation(model.reqs[i], all, ctx);
      var cost = 0;
      for (var j = 0; j < n; j++) {
        var c = pool[assign[j]];
        cost += (c.buy ? c.cost * BUY_FACTOR : c.cost) + RATING_W * Math.max(0, (c.it.rating || 0) - 60);
        if (OOP_COST && !fitsSlot(c.it, model.slots[j].typeId)) cost += OOP_COST;
      }
      return { viol: viol, cost: cost };
    }


    // Final descent: replace one card at a time by anything cheaper that keeps every rule satisfied, until no
    // single swap helps (so the answer is a true 1-swap optimum, also in rating).
    function polish(res) {
      var assign = res.assign, cur = evaluate(assign), improved = true, tEnd = Date.now() + (opts.polishMs || 1500);
      var usedP = new Set(assign), usedD = new Set(assign.map(function (ix) { return pool[ix].it.definitionId; }));
      while (improved && Date.now() < tEnd) {
        improved = false;
        for (var sl = 0; sl < n; sl++) {
          var old = assign[sl], bestC = -1, bestV = cur;
          for (var c = 0; c < P; c++) {
            if (usedP.has(c) || usedD.has(pool[c].it.definitionId)) continue;
            assign[sl] = c;
            var nv = evaluate(assign);
            if (nv.viol === 0 && nv.cost < bestV.cost - 1e-9) { bestV = nv; bestC = c; }
          }
          assign[sl] = old;
          if (bestC >= 0) {
            usedP.delete(old); usedD.delete(pool[old].it.definitionId);
            assign[sl] = bestC; usedP.add(bestC); usedD.add(pool[bestC].it.definitionId);
            cur = bestV; improved = true;
          }
        }
      }
      res.cost = cur.cost;
    }

    var best = null, bestAny = null, feas = [], feasKeys = new Set();
    var addFeas = function (cost, assign) {
      var key = assign.map(function (ix) { return pool[ix].it.id; }).sort().join(',');
      if (feasKeys.has(key)) return;
      feasKeys.add(key);
      feas.push({ cost: cost, assign: assign.slice() });
      if (feas.length > 60) { feas.sort(function (x, y) { return x.cost - y.cost; }); feas.length = 30; }
    };
    var budget = opts.ms || 6000, t0 = Date.now(), restarts = opts.restarts || 60, steps = opts.steps || 4000;
    var avgCost = pool.reduce(function (a, p) { return a + p.cost; }, 0) / P || 1;
    var W0 = Math.max(300, avgCost * 2.5), W1 = VIOL_W;

    // a card close to the ones already chosen (same nation / league / club), or null
    function cohesive(assign, skipSlot) {
      var m = assign[Math.floor(rnd() * assign.length)];
      var gi = Math.floor(rnd() * 3);
      var arr = groups[gi].get(attrOf[gi](pool[m].it));
      return arr && arr.length ? arr[Math.floor(rnd() * arr.length)] : null;
    }

    var tFound = 0;
    var ownedIdx = [];
    for (var oi = 0; oi < P; oi++) if (!pool[oi].buy) ownedIdx.push(oi);
    var anyIdx = function () { return ownedIdx.length && ownedIdx.length < P && rnd() < 0.5 ? ownedIdx[Math.floor(rnd() * ownedIdx.length)] : Math.floor(rnd() * P); };
    for (var rs = 0; rs < restarts && Date.now() - t0 < budget && !(opts.stop && opts.stop()); rs++) {
      var used = new Set(), usedDef = new Set(), assign = [];
      var fromBest = best && rnd() < 0.6;
      if (fromBest) { // iterated local search: perturb the best squad found so far
        assign = best.assign.slice();
        var kicks = 2 + Math.floor(rnd() * 3);
        assign.forEach(function (ix) { used.add(ix); usedDef.add(pool[ix].it.definitionId); });
        for (var kk = 0; kk < kicks; kk++) {
          var ks = Math.floor(rnd() * n), kc = anyIdx(), ko = assign[ks];
          if (kc === ko || used.has(kc) || usedDef.has(pool[kc].it.definitionId)) continue;
          used.delete(ko); usedDef.delete(pool[ko].it.definitionId); assign[ks] = kc; used.add(kc); usedDef.add(pool[kc].it.definitionId);
        }
      }
      for (var s = assign.length; s < n; s++) {
        var pick = -1, tries = 0;
        while (tries++ < 80) {
          var ix;
          if (assign.length && rnd() < 0.6) ix = cohesive(assign); else ix = anyIdx();
          if (ix !== null && !used.has(ix) && !usedDef.has(pool[ix].it.definitionId)) { pick = ix; break; }
        }
        if (pick < 0) for (var q = 0; q < P; q++) if (!used.has(q) && !usedDef.has(pool[q].it.definitionId)) { pick = q; break; }
        if (pick < 0) return { feasible: false, viol: Infinity, cost: Infinity, assign: null, alts: [] };
        used.add(pick); usedDef.add(pool[pick].it.definitionId); assign.push(pick);
      }
      var cur = evaluate(assign);
      var rank0 = VIOL_W * cur.viol + cur.cost; // the starting squad counts too (tiny pools have no moves at all)
      if (cur.viol === 0) { addFeas(cur.cost, assign); if (!best || cur.cost < best.cost) best = { feasible: true, viol: 0, cost: cur.cost, assign: assign.slice() }; }
      if (!bestAny || rank0 < bestAny.E) bestAny = { feasible: cur.viol === 0, viol: cur.viol, cost: cur.cost, assign: assign.slice(), E: rank0 };
      var T0 = Math.max(150, avgCost * (fromBest ? 0.3 : 0.8)), T = T0, alphaT = Math.pow(0.03, 1 / steps), Wstart = fromBest ? W0 * 6 : W0, growW = Math.pow(W1 / Wstart, 1 / steps), Wt = Wstart;
      var E = Wt * cur.viol + cur.cost;
      for (var st = 0; st < steps; st++) {
        var slot = Math.floor(rnd() * n), cand;
        var r = rnd();
        if (r < 0.45) cand = cohesive(assign);
        else if (r < 0.7 && fits[slot].length) cand = fits[slot][Math.floor(rnd() * fits[slot].length)];
        else cand = anyIdx();
        var old = assign[slot];
        Wt *= growW; T *= alphaT;
        if (cand === null || cand === old || used.has(cand) || usedDef.has(pool[cand].it.definitionId)) continue;
        assign[slot] = cand;
        var nv = evaluate(assign), nE = Wt * nv.viol + nv.cost;
        E = Wt * cur.viol + cur.cost; // same weight for both sides of the comparison
        if (nE <= E || rnd() < Math.exp((E - nE) / T)) {
          used.delete(old); usedDef.delete(pool[old].it.definitionId);
          used.add(cand); usedDef.add(pool[cand].it.definitionId);
          cur = nv;
          if (nv.viol === 0) { addFeas(nv.cost, assign); if (!best || nv.cost < best.cost) best = { feasible: true, viol: 0, cost: nv.cost, assign: assign.slice() }; }
          var rank = VIOL_W * nv.viol + nv.cost;
          if (!bestAny || rank < bestAny.E) bestAny = { feasible: nv.viol === 0, viol: nv.viol, cost: nv.cost, assign: assign.slice(), E: rank };
        } else assign[slot] = old;
        if (st % 1500 === 0) { await new Promise(function (r2) { setTimeout(r2, 0); }); if (opts.stop && opts.stop()) break; }
      }
      if (best && !tFound) tFound = Date.now();
      if (best && (rs + 1 >= (opts.minRestarts || 8) || Date.now() - tFound > (opts.afterMs || 4000))) break;
    }
    if (best) polish(best);
    feas.sort(function (x, y) { return x.cost - y.cost; });
    var out = best || bestAny || { feasible: false, viol: Infinity, cost: Infinity, assign: null };
    out.alts = feas.slice(0, 25);
    return out;
  }


  // Rules like "exactly 2 nations" / "max 3 leagues" are needle-in-a-haystack for plain annealing. When the plain
  // search fails, enumerate which nations / leagues / clubs to use (top candidates, cheapest first), restrict the
  // pool to them and anneal inside each restriction.
  function combos(arr, k) {
    var out = [];
    (function rec(start, cur) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (var i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    })(0, []);
    return out;
  }
  // the quantity the search minimises for one card (the same terms as evaluate())
  function objectiveOf(p) { return (p.buy ? p.cost * BUY_FACTOR : p.cost) + RATING_W * Math.max(0, (p.it.rating || 0) - 60); }
  function structureOf(model) {
    var k = K(), out = [];
    model.reqs.forEach(function (r) {
      var attr = r.keyValue === k.NATION_COUNT ? 'nationId' : r.keyValue === k.LEAGUE_COUNT ? 'leagueId' : r.keyValue === k.CLUB_COUNT ? 'teamId' : null;
      if (attr && (r.isLower || r.isExact) && r.count >= 1 && r.count <= 5) out.push({ attr: attr, n: r.count });
    });
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  }

  async function search(model, pool, opts) {
    opts = opts || {};
    var st = structureOf(model), n = model.slots.length;
    var core = await searchCore(model, pool, st.length ? Object.assign({}, opts, { ms: 1500, restarts: 10, minRestarts: 1 }) : opts);
    if (core.feasible && !st.length) return core;
    if (!st.length || pool.length < n + 4) return core;

    var t0 = Date.now(), limit = opts.structMs || 14000, best = core.feasible ? core : null, bestLeaf = null, leaves = 0, tried = 0, wantLeaves = opts.subsets || 40;
    var breadth = [12, 6, 4];
    var debug = globalThis.__nitroDebug;
    // enumerate attribute subsets of one structure level inside the cards `idx` (indexes into pool)
    function subsetsFor(idx, level) {
      var attr = st[level].attr, size = st[level].n, byVal = new Map();
      idx.forEach(function (i) { var v = attrVal(pool[i].it, attr); if (!byVal.has(v)) byVal.set(v, []); byVal.get(v).push(i); });
      var vals = Array.from(byVal.keys()).sort(function (a, b) { return byVal.get(b).length - byVal.get(a).length; });
      var V = size <= 2 ? 16 : size === 3 ? 10 : 8;
      vals = vals.slice(0, V);
      if (vals.length < size) return [];
      return combos(vals, size).map(function (c) {
        var members = [];
        c.forEach(function (v) { members = members.concat(byVal.get(v)); });
        var costs = members.map(function (i) { return objectiveOf(pool[i]); }).sort(function (a, b) { return a - b; });
        return { idx: members, score: members.length < n ? Infinity : costs.slice(0, n).reduce(function (a, b) { return a + b; }, 0) - members.length * 5 };
      }).filter(function (c) { return c.score < Infinity; }).sort(function (a, b) { return a.score - b.score; }).slice(0, breadth[Math.min(level, breadth.length - 1)]);
    }
    // inside one nation / league choice all owned cards stay, but of the cards to buy only the cheapest few per
    // (nation, league) and per club matter (the rest are interchangeable): a small pool anneals reliably
    function trimLeaf(idx) {
      var keepIdx = [], seenKeys = {}, buys = [];
      idx.forEach(function (i) { if (!pool[i].buy) keepIdx.push(i); else buys.push(i); });
      buys.sort(function (a, b) { return objectiveOf(pool[a]) - objectiveOf(pool[b]); });
      buys.forEach(function (i) {
        var it = pool[i].it, k1 = 'NL' + it.nationId + '|' + it.leagueId, k2 = 'T' + it.teamId, k3 = 'ALL';
        var a = seenKeys[k1] || 0, b = seenKeys[k2] || 0, c = seenKeys[k3] || 0;
        if (a < 4 || b < 2 || c < 6) { keepIdx.push(i); seenKeys[k1] = a + 1; seenKeys[k2] = b + 1; seenKeys[k3] = c + 1; }
      });
      return keepIdx;
    }
    async function descend(idx, level) {
      if (Date.now() - t0 > limit || leaves >= wantLeaves || (opts.stop && opts.stop())) return;
      if (level >= st.length) {
        idx = trimLeaf(idx);
        var sub = idx.map(function (i) { return pool[i]; });
        var r = await searchCore(model, sub, { seed: (opts.seed || 1) + leaves * 7 + idx.length + tried, ms: opts.leafMs || 1100, restarts: 6, minRestarts: 2, afterMs: 700, steps: 3000, stop: opts.stop });
        tried++;
        if (opts.onProgress) opts.onProgress({ tried: tried, leaves: leaves, best: best && best.cost });
        if (debug) debug('  leaf size=' + sub.length + ' feas=' + r.feasible + ' viol=' + r.viol + ' cost=' + Math.round(r.cost));
        if (!r.assign) return;
        var mapped = { feasible: r.feasible, viol: r.viol, cost: r.cost, assign: r.assign.map(function (j) { return idx[j]; }),
          alts: (r.alts || []).map(function (a) { return { cost: a.cost, assign: a.assign.map(function (j) { return idx[j]; }) }; }) };
        if (mapped.feasible) { leaves++; if (!best || mapped.cost < best.cost) { best = mapped; bestLeaf = idx; } }
        else if (!best && (mapped.viol < core.viol || (mapped.viol === core.viol && mapped.cost < core.cost))) core = mapped;
        return;
      }
      var subs = subsetsFor(idx, level);
      if (debug) debug('structured level ' + level + ' attr=' + st[level].attr + ' subsets=' + subs.length + ' cards=' + idx.length);
      for (var i = 0; i < subs.length && Date.now() - t0 < limit && leaves < wantLeaves && !(opts.stop && opts.stop()); i++) await descend(subs[i].idx, level + 1);
    }
    await descend(pool.map(function (_, i) { return i; }), 0);
    // intensify: spend extra effort inside the nations / leagues of the best squad found
    if (bestLeaf && !opts.noIntensify && !(opts.stop && opts.stop())) {
      var subPool = bestLeaf.map(function (i) { return pool[i]; });
      var deep = await searchCore(model, subPool, { seed: (opts.seed || 1) + 4242, ms: opts.deepMs || 2000, restarts: 24, minRestarts: 12, afterMs: opts.deepMs || 2000, steps: 5000, stop: opts.stop });
      if (deep.feasible && deep.assign && deep.cost < best.cost) {
        best = { feasible: true, viol: 0, cost: deep.cost, assign: deep.assign.map(function (j) { return bestLeaf[j]; }),
          alts: (deep.alts || []).map(function (a) { return { cost: a.cost, assign: a.assign.map(function (j) { return bestLeaf[j]; }) }; }) };
      }
    }
    return best || core;
  }

  globalThis.__nitroSbcSearch = search;
  globalThis.__nitroSbcPure = { teamRating: teamRating, fitsSlot: fitsSlot, reqViolation: reqViolation, cardAllowed: cardAllowed, compare: compare, PER_ITEM: PER_ITEM };
  if (typeof document === 'undefined') return; // unit tests: pure helpers only

  // ---------- page integration ----------

  // Requirement wrapper (same semantics as the game's own checklist)
  function wrapReq(dto) {
    var k = K(), S = globalThis.SBCEligibilityScope || {};
    var key = dto.getFirstKey();
    var vals = dto.getValue(key) || [];
    var multi = vals.length > 1;
    var groupKeys = [k.SAME_NATION_COUNT, k.SAME_LEAGUE_COUNT, k.SAME_CLUB_COUNT, k.NATION_COUNT, k.LEAGUE_COUNT, k.CLUB_COUNT];
    var sameKeys = [k.SAME_NATION_COUNT, k.SAME_LEAGUE_COUNT, k.SAME_CLUB_COUNT];
    var canGroup = groupKeys.indexOf(key) !== -1;
    var value = multi ? new Set(vals) : dto.getFirstValue(key);
    var r = {
      keyValue: key, canGroup: canGroup, sameCount: sameKeys.indexOf(key) !== -1,
      count: canGroup ? dto.getFirstValue(key) : dto.count, value: value, hasMultipleValues: multi,
      isExact: dto.scope === S.EXACT, isLower: dto.scope === S.LOWER, isGreater: dto.scope === S.GREATER,
      isCombined: !!dto.isCombinedRequirement,
    };
    var has = function (v) { return multi ? value.has(v) : value === v; };
    r.satifiesRequirement = function (it) {
      switch (key) {
        case k.CLUB_ID: return has(it.teamId);
        case k.FIRST_OWNER_PLAYERS_COUNT: return it.owners === 0;
        case k.LEAGUE_ID: return has(it.leagueId);
        case k.NATION_ID: return has(it.nationId);
        case k.PLAYER_EXACT_OVR: return has(it.rating);
        case k.PLAYER_MAX_OVR: return it.rating <= value;
        case k.PLAYER_MIN_OVR: return it.rating >= value;
        case k.PLAYER_RARITY: return has(it.rareflag);
        case k.PLAYER_RARITY_GROUP: try { return !!it.belongsToGroup(value); } catch (e) { return false; }
        case k.PLAYER_TRADABILITY: return it.tradable === value;
        default: return false;
      }
    };
    r.group = function (items) {
      var f = key === k.SAME_NATION_COUNT || key === k.NATION_COUNT ? function (x) { return x.nationId; }
        : key === k.SAME_LEAGUE_COUNT || key === k.LEAGUE_COUNT ? function (x) { return x.leagueId; } : clubKey;
      var out = {};
      items.forEach(function (x) { var g = f(x); (out[g] = out[g] || []).push(x); });
      return out;
    };
    return r;
  }
  globalThis.__nitroSbcPure.wrapReq = wrapReq;
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function obs(o) {
    return new Promise(function (res, rej) {
      var NS = {};
      o.observe(NS, function (s, r) { s.unobserve(NS); r && r.success ? res(r) : rej(new Error(r && r.error)); });
    });
  }
  var LIB = function () { return globalThis.__nitroLib || {}; };

  async function loadClub() {
    var all = [], crit = new UTItemSearchViewModel().searchCriteria;
    crit.count = 91; crit.type = SearchType.PLAYER; crit.sortBy = SearchSortType.RATING; crit.sort = SearchSortOrder.DESCENDING;
    for (var off = 0; off < 20000; off += 91) {
      crit.offset = off;
      var r = await obs(services.Club.search(crit));
      all = all.concat(r.response.items || []);
      if (r.response.retrievedAll || (r.response.items || []).length < 91) break;
      await wait(60);
    }
    return all;
  }
  async function loadStorage() {
    try {
      var r = await obs(services.Item.searchStorageItems(new UTSearchCriteriaDTO()));
      return (r.response.items || []).filter(function (it) { return it.type === ItemType.PLAYER; });
    } catch (e) { return []; }
  }
  // Unowned cards in a rating range. The concept search ignores rating filters but is sorted by rating,
  // so: filter by level (bronze/silver/gold), binary-search the offset of the first card >= lo, then page up to hi.
  async function conceptRange(ranges, levels) {
    var all = [], seenIds = new Set();
    for (var ri = 0; ri < ranges.length; ri++) {
      var part = await conceptRangeOne(ranges[ri][0], ranges[ri][1], levels);
      part.forEach(function (it) { if (!seenIds.has(it.definitionId)) { seenIds.add(it.definitionId); all.push(it); } });
    }
    return all;
  }
  async function conceptRangeOne(lo, hi, levels) {
    var out = [];
    var mk = function (level, count, offset) {
      var c = new UTSearchCriteriaDTO();
      c.type = SearchType.PLAYER; c.sortBy = SearchSortType.RATING; c.sort = SearchSortOrder.ASCENDING;
      c.count = count; c.offset = offset; c.rarities = [0, 1]; c.level = level;
      return c;
    };
    var bands = [
      { level: SearchLevel.BRONZE, from: 0, to: 64 },
      { level: SearchLevel.SILVER, from: 65, to: 74 },
      { level: SearchLevel.GOLD, from: 75, to: 99 },
    ];
    for (var b = 0; b < bands.length; b++) {
      var band = bands[b], from = Math.max(lo, band.from), to = Math.min(hi, band.to);
      if (from > to || band.level === undefined) continue;
      if (levels && levels.indexOf(band.level) === -1) continue;
      var l = 0, h = 30000;
      while (l < h) {
        var mid = (l + h) >> 1;
        var pr = await obs(services.Item.searchConceptItems(mk(band.level, 1, mid)));
        var first = (pr.response.items || [])[0];
        if (!first || first.rating >= from) h = mid; else l = mid + 1;
      }
      var off = l;
      for (var page = 0; page < 14; page++) {
        var r = await obs(services.Item.searchConceptItems(mk(band.level, 91, off)));
        var arr = r.response.items || [];
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].rating > to) { page = 99; break; }
          if (arr[i].rating >= from) { arr[i].isConceptPlayer = true; out.push(arr[i]); }
        }
        if (arr.length < 91) break;
        off += 91;
        await wait(90);
      }
    }
    return out;
  }


  // Which ratings / levels the cards to buy may have: every "all players must ..." rule narrows it, the team
  // rating (if any) centres it; with no rule at all the cheapest cards are enough.
  async function buyWindow(model) {
    var k = K(), reqs = model.reqs, lo = 46, hi = 99;
    reqs.forEach(function (r) {
      if (r.count !== -1 || r.isCombined || r.hasMultipleValues) return;
      if (r.keyValue === k.PLAYER_MIN_OVR) lo = Math.max(lo, r.value);
      if (r.keyValue === k.PLAYER_MAX_OVR) hi = Math.min(hi, r.value);
      if (r.keyValue === k.PLAYER_EXACT_OVR) { lo = Math.max(lo, r.value); hi = Math.min(hi, r.value); }
    });
    var tierReqs = reqs.filter(function (r) { return (r.keyValue === k.PLAYER_QUALITY || r.keyValue === k.PLAYER_LEVEL) && r.count === -1; });
    var bands = [
      { level: SearchLevel.BRONZE, from: 46, to: 64 },
      { level: SearchLevel.SILVER, from: 65, to: 74 },
      { level: SearchLevel.GOLD, from: 75, to: 99 },
    ];
    var levels = [];
    for (var i = 0; i < bands.length; i++) {
      var band = bands[i];
      if (band.level === undefined) continue;
      if (!tierReqs.length) { levels.push(band); continue; }
      try {
        var c = new UTSearchCriteriaDTO();
        c.type = SearchType.PLAYER; c.sortBy = SearchSortType.RATING; c.sort = SearchSortOrder.ASCENDING; c.count = 1; c.offset = 0; c.rarities = [0, 1]; c.level = band.level;
        var pr = await obs(services.Item.searchConceptItems(c));
        var probe = (pr.response.items || [])[0];
        if (probe && tierReqs.every(function (r) { return satisfies(r, probe); })) levels.push(band);
      } catch (e) { levels.push(band); }
    }
    if (!levels.length) levels = bands.filter(function (b) { return b.level !== undefined; });
    lo = Math.max(lo, Math.min.apply(null, levels.map(function (b) { return b.from; })));
    hi = Math.min(hi, Math.max.apply(null, levels.map(function (b) { return b.to; })));
    if (lo > hi) { lo = 65; hi = 75; }
    var tr = reqs.filter(function (r) { return r.keyValue === k.TEAM_RATING && !r.hasMultipleValues; })[0];
    // the cheapest few ratings of every allowed level (counted rules like "3 silver" need them) ...
    var ranges = [];
    levels.forEach(function (b) {
      var from = Math.max(lo, b.from), to = Math.min(hi, b.to, from + 4);
      if (from <= to) ranges.push([from, to]);
    });
    // ... plus the ratings around the requested team rating
    if (tr && tr.value) {
      var wlo = Math.max(lo, tr.value - 3), whi = Math.min(hi, tr.value + 2);
      if (wlo <= whi) ranges.push([wlo, whi]);
    }
    if (!ranges.length) ranges.push([lo, Math.min(hi, lo + 4)]);
    return { ranges: ranges, levels: levels.map(function (b) { return b.level; }) };
  }

  function buildModel(challenge) {
    var sq = challenge.squad, k = K();
    var field = sq.getFieldPlayers();
    var free = sq.getNonBrickSlots().filter(function (s) { return field.some(function (f) { return f.index === s.index; }); });
    var freeIdx = new Set(free.map(function (s) { return s.index; }));
    var reqs = (challenge.eligibilityRequirements || []).map(wrapReq);
    var needChem = reqs.some(function (r) { return r.keyValue === k.CHEMISTRY_POINTS; });
    var floatMode = false;
    try { floatMode = !!services.Configuration.checkFeatureEnabled(UTServerSettingsRepository.KEY.SQUAD_RATING_FLOAT_CALCULATION_ENABLED); } catch (e) { /* default formula */ }
    var fixed = field.filter(function (f) { return !freeIdx.has(f.index) && f.item && f.item.id > 0; }).map(function (f) { return f.item; });
    var formation = sq.getFormation();
    var manager = sq.getManager().item;
    return {
      sq: sq, slots: free.map(function (s) { return { index: s.index, typeId: s.position.typeId, name: s.position.name }; }),
      fixed: fixed, reqs: reqs, perItem: PER_ITEM(), needChem: needChem,
      operationOr: challenge.eligibilityOperation === SBCEligibilityOperation.OR,
      rating: function (ratings, size) { return teamRating(ratings, floatMode, size); },
      chemVO: function (placed, slots) {
        var bySlot = field.map(function (f) {
          var i = slots.findIndex(function (s) { return s.index === f.index; });
          return i >= 0 ? placed[i] : f.item;
        });
        return sq.chemCalculator.calculate(formation, bySlot, manager);
      },
      chemOf: function (placed, slots) { return this.chemVO(placed, slots).chemistry; },
      chemPointsOf: function (placed, slots) {
        var vo = this.chemVO(placed, slots);
        return slots.map(function (s) { return vo.getSlotChemistry(s.index).points; });
      },
    };
  }

  // Players -> summary rows
  // Per requirement: true when my model says it is satisfied (used when the game cannot judge, e.g. cards still to buy).
  function evalReqs(model, players) {
    var all = players.concat(model.fixed || []);
    var ctx = {
      perItem: model.perItem,
      rating: function (items) { return model.rating(items.map(function (x) { return x.rating; }), all.length); },
      chem: function () { return model.chemOf(players, model.slots); },
      chemPoints: function () { return model.chemPointsOf(players, model.slots); },
    };
    return model.reqs.map(function (r) { return reqViolation(r, all, ctx) === 0; });
  }

  function describe(L, model, players) {
    var rows = players.map(function (it, i) {
      return { cells: [model.slots[i].name, L.name(it), String(it.rating || 0), it.concept || it.isConceptPlayer ? 'تحتاج شراء' : L.sourceLabel(it), L.priceLabel(it)] };
    });
    var rat = model.rating(players.concat(model.fixed).map(function (x) { return x.rating; }), model.slots.length + model.fixed.length);
    var chem = model.needChem || true ? model.chemOf(players, model.slots) : 0;
    return { rows: rows, rating: rat, chem: chem, reqOk: evalReqs(model, players) };
  }

  // Puts cards into the free slots of the (draft) squad, without saving.
  function setDraft(challenge, players) {
    var arr = new Array(UTSquadEntity.TOTAL_PLAYERS);
    var slots = challenge.squad.getNonBrickSlots().slice();
    for (var i = 0; i < players.length; i++) {
      var slot = slots.shift();
      if (!slot) break;
      arr[slot.index] = players[i];
    }
    challenge.squad.setPlayers(arr);
  }


  // Compact description of a requirement object, used when the game disagrees with the solver.
  function describeReq(dto) {
    try {
      var k = K(), key = dto.getFirstKey(), name = key;
      Object.keys(k).forEach(function (n) { if (k[n] === key) name = n; });
      var S = globalThis.SBCEligibilityScope || {}, scope = dto.scope;
      Object.keys(S).forEach(function (n) { if (S[n] === scope) scope = n; });
      var v = dto.getValue(key);
      return name + ' · ' + scope + ' · count=' + dto.count + ' · value=' + (v && v.join ? v.join('/') : v);
    } catch (e) { return '?'; }
  }

  // Last resort when the game rejects a squad the solver thought was fine: hill-climb with the GAME as judge.
  async function oracleRepair(challenge, model, pool, startAssign, ms) {
    var n = model.slots.length, P = pool.length, rnd = mulberry(4242), t0 = Date.now();
    var reqs = challenge.eligibilityRequirements || [];
    var squadSize = model.slots.length + (model.fixed || []).length;
    // how far the game says a requirement is from being met (uses the game's own progress counter when it has one)
    function gameGap(r) {
      var met = true;
      try { met = !!challenge.isRequirementMet(r); } catch (e) { met = false; }
      if (met) return 0;
      try {
        var c = challenge.getRequirementCounter(r);
        if (typeof c === 'number') {
          var key = r.getFirstKey(), k = K();
          var groupKey = [k.SAME_NATION_COUNT, k.SAME_LEAGUE_COUNT, k.SAME_CLUB_COUNT, k.NATION_COUNT, k.LEAGUE_COUNT, k.CLUB_COUNT, k.TEAM_RATING, k.CHEMISTRY_POINTS].indexOf(key) !== -1;
          var target = groupKey ? r.getFirstValue(key) : (r.count > 0 ? r.count : squadSize);
          var S = globalThis.SBCEligibilityScope || {};
          var gap = r.scope === S.LOWER ? c - target : target - c;
          return Math.max(1, gap);
        }
      } catch (e) { /* no counter: plain unmet */ }
      return 1;
    }
    function energy(assign) {
      var players = assign.map(function (ix) { return pool[ix].it; });
      setDraft(challenge, players);
      var unmet = 0;
      for (var i = 0; i < reqs.length; i++) unmet += gameGap(reqs[i]);
      var mv = evalReqs(model, players).filter(function (ok) { return !ok; }).length;
      var cost = 0;
      assign.forEach(function (ix) { cost += pool[ix].buy ? pool[ix].cost * BUY_FACTOR : pool[ix].cost; });
      return { unmet: unmet, mv: mv, E: 1e6 * unmet + 1e5 * mv + cost };
    }
    var cur = startAssign.slice(), ce = energy(cur), steps = 0;
    var used = new Set(cur), usedDef = new Set(cur.map(function (ix) { return pool[ix].it.definitionId; }));
    while (Date.now() - t0 < ms && (ce.unmet > 0 || ce.mv > 0)) {
      var slot = Math.floor(rnd() * n), cand = Math.floor(rnd() * P), old = cur[slot];
      if (cand === old || used.has(cand) || usedDef.has(pool[cand].it.definitionId)) continue;
      cur[slot] = cand;
      var ne = energy(cur);
      if (ne.E <= ce.E) {
        used.delete(old); usedDef.delete(pool[old].it.definitionId); used.add(cand); usedDef.add(pool[cand].it.definitionId);
        ce = ne;
      } else cur[slot] = old;
      if (++steps % 25 === 0) await wait(0);
    }
    if (ce.unmet === 0 && challenge.meetsRequirements()) return { assign: cur, players: cur.map(function (ix) { return pool[ix].it; }), steps: steps };
    return null;
  }

  // The entry used by __nitroSolve. Returns null when this challenge is not supported (the old engine runs instead).
  async function solveChallenge(challenge, ctx) {
    var L = LIB();
    if (!globalThis.SBCEligibilityKey) return null;
    var model;
    try { model = buildModel(challenge); } catch (e) { return null; }
    if (!model.slots.length || model.operationOr) return null;

    var stopFlag = false, prog = null;
    try { if (L.showProgress) prog = L.showProgress('جارٍ تحميل ناديك…', function () { stopFlag = true; }, 'اكتفِ بأفضل حل الآن'); } catch (e) { prog = null; }
    var say = function (t) { try { if (prog) prog.set(t); } catch (e) { /* ignore */ } };
    var searchOpts = function (o) {
      return Object.assign({ stop: function () { return stopFlag; }, onProgress: function (p) { say('أبحث عن أرخص حل… جرّبت ' + p.tried + ' توليفة' + (p.best ? '' : '') + '\n(يمكنك الإيقاف والاكتفاء بالأفضل حالياً)'); } }, o);
    };
    try {
    var squadDefs = new Set(ctx.squadDefs || []);
    var raw = (await loadClub()).concat(await loadStorage());
    say('أبحث عن أرخص حل من ناديك…');
    var seen = new Set();
    var owned = raw.filter(function (it) {
      if (!it || it.type !== ItemType.PLAYER || seen.has(it.id)) return false;
      seen.add(it.id);
      return !squadDefs.has(it.definitionId) && !(it.loans > -1) && cardAllowed(model.reqs, model.perItem, it);
    });
    await L.prefetch(owned);
    var lim = L.expensiveLimit();
    var attempts = [];
    var mk = function (arr) { return arr.map(function (it) { return { it: it, cost: L.cost(it), buy: false }; }); };
    var cheap = owned.filter(function (it) { return !lim || L.cost(it) < lim; });
    attempts.push({ label: 'club', pool: mk(cheap), expensive: false });
    if (lim > 0 && cheap.length < owned.length) attempts.push({ label: 'club+expensive', pool: mk(owned), expensive: true });

    var found = null, bestTry = null, usedExpensive = false;
    for (var a = 0; a < attempts.length && !found; a++) {
      var r = await search(model, attempts[a].pool, searchOpts({ seed: 7 + a + (globalThis.__nitroSeedShift || 0), structMs: 5000 }));
      if (r.assign && (!bestTry || r.viol < bestTry.res.viol)) bestTry = { res: r, pool: attempts[a].pool };
      if (r.feasible) { found = { res: r, pool: attempts[a].pool }; usedExpensive = attempts[a].expensive; }
    }
    var bought = false;
    if (!found) {
      // not enough in the club: add the cheapest unowned cards (whatever the squad lacks)
      var pool2 = attempts[attempts.length - 1].pool.slice();
      try {
        var win = await buyWindow(model);
        var concepts = await conceptRange(win.ranges, win.levels);
        concepts = concepts.filter(function (it) { return !squadDefs.has(it.definitionId) && cardAllowed(model.reqs, model.perItem, it); });
        await L.prefetch(concepts);
        var priced = concepts.filter(function (it) { return !L.isEstimated(it); });
        // keep the cheapest few per (rating, league) and (rating, nation) so every requirement stays reachable
        var keep = new Map(), cap = { N: 24, L: 14, T: 5, A: 40 };
        var objC = function (it) { return L.cost(it) + RATING_W * Math.max(0, (it.rating || 0) - 60); };
        priced.sort(function (x, y) { return objC(x) - objC(y); }).forEach(function (it) {
          ['N' + it.nationId, 'L' + it.leagueId, 'T' + it.teamId, 'A'].forEach(function (key) {
            var arr = keep.get(key) || [];
            if (arr.length < cap[key.charAt(0)]) { arr.push(it); keep.set(key, arr); }
          });
        });
        var picked = new Set();
        keep.forEach(function (arr) { arr.forEach(function (it) { picked.add(it); }); });
        picked.forEach(function (it) { pool2.push({ it: it, cost: L.cost(it), buy: true }); });
      } catch (e) { /* purchases unavailable: the club-only best effort is used */ }
      if (pool2.some(function (p) { return p.buy; })) {
        say('ناديك ما يكفي: أبحث عن أقل بطاقات شراء وأرخصها…');
        var r2 = await search(model, pool2, searchOpts({ seed: 99 + (globalThis.__nitroSeedShift || 0), ms: 9000, restarts: 60, structMs: 9000 }));
        if (r2.assign && (!bestTry || r2.viol < bestTry.res.viol)) bestTry = { res: r2, pool: pool2 };
        if (r2.feasible) { found = { res: r2, pool: pool2 }; bought = true; usedExpensive = true; }
      }
    }
    var chosen = found || bestTry;
    if (!chosen || !chosen.res.assign) return { success: false, players: [], model: model, ctx: ctx };
    say('أتأكد من الحل عند لعبة EA…');
    var players = chosen.res.assign.map(function (ix) { return chosen.pool[ix].it; });
    var verified = null, repaired = false;
    if (found && !bought) {
      // ask the game itself: try the cheapest candidates until one is accepted by meetsRequirements()
      var alts = (found.res.alts && found.res.alts.length ? found.res.alts : [{ assign: found.res.assign }]).slice(0, 12);
      verified = false;
      for (var vi = 0; vi < alts.length; vi++) {
        var cand = alts[vi].assign.map(function (ix) { return found.pool[ix].it; });
        try {
          setDraft(challenge, cand);
          if (challenge.meetsRequirements()) { players = cand; verified = true; break; }
        } catch (e) { verified = null; break; }
      }
      if (verified === false) {
        // every cheap candidate was refused: let the game guide a repair search
        try {
          var rep = await oracleRepair(challenge, model, found.pool, found.res.assign, 8000);
          if (rep) { players = rep.players; verified = true; repaired = true; }
        } catch (e) { /* keep the best candidate */ }
      }
      if (verified === false) { try { setDraft(challenge, players); } catch (e) { /* ignore */ } }
    }
    return { success: !!found, verified: verified, repaired: repaired, reqDiag: (challenge.eligibilityRequirements || []).map(describeReq), players: players, model: model, bought: bought, usedExpensive: usedExpensive, ctx: ctx, describe: describe(L, model, players) };
    } finally { try { if (prog) prog.close(); } catch (e) { /* ignore */ } }
  }

  globalThis.__nitroSbc = { solve: solveChallenge };
})();
