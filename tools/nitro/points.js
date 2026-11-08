// Nitro points-SBC solver (the "pick players, each worth points" SBCs: UTOneClickSBCWorkArea...).
// Adds a "نيترو" button next to Auto-Select. It
//   - excludes your active squad (all copies of those players) and loaned cards,
//   - keeps expensive players out automatically (relaxed only if the target is unreachable otherwise),
//   - finds the cheapest combination (market value for every card, also untradeable ones),
//     then the fewest players, then the lowest rating,
//   - selects the first batch and shows a summary (with the total cost in coins),
//   - on request ("نفّذ الحل كاملاً") submits all batches, asking for a second click first.
(function () {
  var LIB = function () { return globalThis.__nitroLib || {}; };
  var PLAYER_PENALTY = 50; // default (coins): an extra player must save more than this; editable in Nitro settings

  // ---------- pure planner (unit-tested in Node) ----------
  // items: [{score, coins, pen}]  ->  {ok, picks:[idx], score, coins, shortfall}
  // minimises total coins, then total pen. coins here is the optimisation weight.
  function planPoints(items, target) {
    var n = items.length;
    var total = 0;
    items.forEach(function (i) { total += i.score; });
    if (target <= 0) return { ok: true, picks: [], score: 0, coins: 0 };
    if (total < target) return { ok: false, picks: [], score: 0, coins: 0, shortfall: target - total };

    function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }
    var unit = 0;
    items.forEach(function (i) { unit = gcd(unit, i.score); });
    unit = unit || 1;
    var Tn = Math.ceil(target / unit), maxW = 0;
    var w = items.map(function (i) { var x = Math.round(i.score / unit); if (x > maxW) maxW = x; return x; });
    var S = Tn + maxW;

    var best = -1, picks = [];
    if (n * (S + 1) <= 3e8) {
      var C = new Float64Array(S + 1).fill(Infinity), Pn = new Float64Array(S + 1).fill(Infinity);
      C[0] = 0; Pn[0] = 0;
      var bits = new Uint8Array(Math.ceil((n * (S + 1)) / 8));
      for (var i = 0; i < n; i++) {
        var wi = w[i], ci = items[i].coins, pi = items[i].pen, base = i * (S + 1);
        for (var s = S - wi; s >= 0; s--) {
          var cs = C[s];
          if (cs === Infinity) continue;
          var t = s + wi, nc = cs + ci, np = Pn[s] + pi;
          if (nc < C[t] || (nc === C[t] && np < Pn[t])) {
            C[t] = nc; Pn[t] = np;
            var b = base + t; bits[b >> 3] |= 1 << (b & 7);
          }
        }
      }
      for (var s2 = Tn; s2 <= S; s2++) {
        if (C[s2] === Infinity) continue;
        if (best < 0 || C[s2] < C[best] || (C[s2] === C[best] && Pn[s2] < Pn[best])) best = s2;
      }
      var cur = best;
      for (var k = n - 1; k >= 0 && cur > 0; k--) {
        var bb = k * (S + 1) + cur;
        if (bits[bb >> 3] & (1 << (bb & 7))) { picks.push(k); cur -= w[k]; }
      }
    } else {
      // huge instance: greedy by cost per point
      var order = items.map(function (_, ix) { return ix; }).sort(function (a, b) {
        var x = items[a], y = items[b];
        return x.coins / x.score - y.coins / y.score || x.pen / x.score - y.pen / y.score;
      });
      var acc = 0;
      for (var q = 0; q < order.length && acc < target; q++) { picks.push(order[q]); acc += items[order[q]].score; }
    }
    var sc = 0, co = 0;
    picks.forEach(function (ix) { sc += items[ix].score; co += items[ix].coins; });
    return { ok: sc >= target, picks: picks, score: sc, coins: co };
  }
  globalThis.__nitroPlanPoints = planPoints;
  globalThis.__nitroPlayerPenalty = PLAYER_PENALTY;
  if (typeof document === 'undefined') return; // unit tests: planner only

  // ---------- page integration ----------
  var pen = function (rating) { return Math.pow(2, (rating || 60) - 60); }; // tie-break: burn low ratings first
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var call = function (fn) { return new Promise(function (res) { try { fn(res); } catch (e) { res(); } }); };
  async function until(pred, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { var v = pred(); if (v) return v; } catch (e) { /* keep waiting */ }
      await wait(400);
    }
    return null;
  }

  function currentWorkArea() {
    var c = getAppMain().getRootViewController().getPresentedViewController().getCurrentViewController();
    var cur = c && c.getCurrentController ? c.getCurrentController() : c;
    return cur && cur.workAreaController && cur.workAreaController.viewModel ? cur.workAreaController : null;
  }
  function currentReview() {
    var c = getAppMain().getRootViewController().getPresentedViewController().getCurrentViewController();
    var cur = c && c.getCurrentController ? c.getCurrentController() : c;
    if (!cur || cur.constructor.name !== 'UTOneClickSBCReviewSplitViewController') return null;
    return (cur.childViewControllers || []).filter(function (k) { return typeof k.submitSelection === 'function'; })[0] || null;
  }

  async function loadAll(vm) {
    var tabs = ['club', 'storage'];
    for (var t = 0; t < tabs.length; t++) {
      await call(function (cb) { vm.setActiveTab(tabs[t], cb); });
      var guard = 0;
      while (vm.hasNextPage() && guard++ < 400) await call(function (cb) { vm.nextPage(cb); });
    }
    await call(function (cb) { vm.setActiveTab('club', cb); });
    await call(function (cb) { vm.loadInitialPage(cb); });
  }

  async function squadDefIds(L) {
    try {
      var r = await L.observe(new UTItemSearchViewModel().requestActiveSquadDefIds());
      return new Set((r.data && r.data.defIds) || []);
    } catch (e) { return null; }
  }

  // Cheapest plan for what is still missing. Expensive players are kept out first; if the
  // target is unreachable that way the limit is relaxed (x3, then off) and reported.
  async function computePlan(L, vm, squad) {
    var ch = vm.getChallenge();
    var target = (ch.scoreRequirement || 0) - (ch.submittedScore || 0);
    var all = Array.from(vm._itemEntityMap.values());
    var base = all.filter(function (it) { return it.sbsScore > 0 && !squad.has(it.definitionId) && !(it.loans > -1); });
    await L.prefetch(base);
    var lim = L.expensiveLimit();
    var penalty = L.settings().playerPenalty;
    var ladder = lim > 0 ? [lim, lim * 3, 0] : [0];
    var plan = null, rows = null, used = 0;
    for (var li = 0; li < ladder.length; li++) {
      var cap = ladder[li];
      var cand = base.filter(function (it) { return !cap || L.cost(it) < cap; });
      rows = cand.map(function (it) { return { it: it, score: it.sbsScore, real: L.cost(it), coins: L.cost(it) + penalty, pen: pen(it.rating) }; });
      plan = planPoints(rows, target);
      used = cap;
      if (plan.ok) break;
    }
    var picked = plan.ok ? plan.picks.map(function (ix) { return rows[ix]; }).sort(function (a, b) { return b.score - a.score || a.real - b.real; }) : [];
    return { target: target, ok: plan.ok, shortfall: plan.shortfall, picked: picked, excluded: all.length - base.length, cap: used, firstCap: lim, score: plan.score };
  }

  function selectBatch(wa, batch) {
    var vm = wa.viewModel;
    vm.clearSelection();
    batch.forEach(function (r) { vm.selectItem(r.it); });
    wa._refreshCurrentPage && wa._refreshCurrentPage();
    wa._refreshSelectionControls && wa._refreshSelectionControls();
  }

  function capNote(L, p) {
    if (!p.firstCap) return '';
    return p.cap === p.firstCap ? 'استُبعد تلقائياً أي لاعب سعره ≥ ' + L.fmt(p.firstCap) + ' كوينز. '
      : (p.cap ? 'لم يكفِ الحل بدون اللاعبين الغالين فسُمح حتى ' + L.fmt(p.cap) + ' كوينز. ' : 'لم يكفِ الحل بدون اللاعبين الغالين فاستُخدم بعضهم. ');
  }

  async function solve(btn) {
    var L = LIB();
    var wa = currentWorkArea();
    if (!wa) return;
    var vm = wa.viewModel;
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'جارٍ الحساب…';
    globalThis.__nitroActive = true;
    try {
      await loadAll(vm);
      var squad = await squadDefIds(L);
      if (!squad) { L.showSummary({ ok: false, title: 'تعذّر الحل', reason: 'ما قدرت أقرأ تشكيلتك الفعّالة، لذلك لم أبدأ حتى لا ألمس لاعبيك الأساسيين.' }); return; }
      vm.clearSelection();
      var p = await computePlan(L, vm, squad);
      var title = '⚡ ملخص حل نيترو (نقاط)';
      if (p.target <= 0) { L.showSummary({ ok: false, title: title, reason: 'الهدف مكتمل أصلاً.' }); return; }
      if (!p.ok) {
        L.showSummary({ ok: false, title: 'تعذّر الحل', reason: 'المتاح بعد الاستبعاد لا يكفي: ينقصك ' + (p.shortfall || '') + ' نقطة.\nالمستبعد: ' + p.excluded + ' بطاقة (تشكيلتك الفعّالة أو معارة).' });
        wa._refreshCurrentPage && wa._refreshCurrentPage(); wa._refreshSelectionControls && wa._refreshSelectionControls();
        return;
      }
      var limit = vm.getSelectionLimit() || 30;
      var batches = Math.ceil(p.picked.length / limit);
      var first = p.picked.slice(0, limit);
      selectBatch(wa, first);

      var firstScore = first.reduce(function (a, r) { return a + r.score; }, 0);
      var players = p.picked.map(function (r) { return r.it; });
      var rows = p.picked.map(function (r, i) {
        return { cells: [L.name(r.it), String(r.it.rating || 0), String(r.score), L.priceLabel(r.it, r.score), String(Math.floor(i / limit) + 1) + ' · ' + L.sourceLabel(r.it)] };
      });
      var t = L.totals(players);
      var avgRating = (players.reduce(function (a, it) { return a + (it.rating || 0); }, 0) / players.length).toFixed(1);
      var batchLines = '';
      if (batches > 1) {
        for (var bi = 0; bi < batches; bi++) {
          var part = p.picked.slice(bi * limit, (bi + 1) * limit);
          batchLines += '\nالدفعة ' + (bi + 1) + ': ' + part.length + ' لاعب · ' + part.reduce(function (a, r) { return a + r.score; }, 0) + ' نقطة · ' + L.fmt(part.reduce(function (a, r) { return a + r.real; }, 0)) + ' كوينز';
        }
      }
      var perPoint = p.score > 0 ? (t.all / p.score).toFixed(2) : '0';
      L.showSummary({
        ok: true, title: title,
        note: 'المطلوب ' + p.target + ' نقطة — المختار ' + p.score + ' نقطة. استُبعدت تشكيلتك الفعّالة والمعارون (' + p.excluded + ' بطاقة). ' + capNote(L, p) + 'الاختيار: الأقل تكلفة ثم الأقل لاعبين ثم الأقل تقييماً.',
        rows: rows,
        columns: [{ h: 'اللاعب' }, { h: 'التقييم', k: 'rating' }, { h: 'النقاط', k: 'pts' }, { h: 'السعر · كوينز/نقطة', k: 'price' }, { h: 'دفعة · المصدر' }],
        totalRow: ['المجموع (' + players.length + ' لاعب)', avgRating + ' (متوسط)', String(p.score), L.fmt(t.all), batches + ' دفعة'],
        total: L.costLine(t, players.length) + batchLines +
          '\nالسعر لكل نقطة: ' + perPoint + ' كوينز · الفائض عن المطلوب: ' + (p.score - p.target) + ' نقطة' +
          '\nحُدّدت الدفعة 1 من ' + batches + ' (' + first.length + ' لاعب، ' + firstScore + ' نقطة).',
        actions: [{
          label: '⚡ نفّذ الحل كاملاً (إرسال ' + batches + ' دفعة)',
          confirm: 'تأكيد: إرسال نهائي لـ ' + players.length + ' لاعب — اضغط مرة ثانية',
          onClick: function () { runAll(); },
        }],
      });
    } catch (e) {
      try { L.showSummary({ ok: false, title: 'تعذّر الحل', reason: String((e && e.message) || e) }); } catch (x) { /* ignore */ }
    } finally {
      globalThis.__nitroActive = false;
      btn.disabled = false; btn.textContent = label;
    }
  }

  // Submits every batch: select -> open the native review screen -> submitSelection().
  // Re-plans before each batch (self-correcting) and stops at the first thing that looks wrong.
  async function runAll() {
    var L = LIB();
    var stop = false, spent = 0, locked = 0, sent = 0, batches = 0, msg = null, finished = false, doneRows = [], donePts = 0, doneRating = 0;
    var prog = L.showProgress('جارٍ الحل…', function () { stop = true; });
    globalThis.__nitroActive = true;
    try {
      for (var guard = 0; guard < 40 && !stop; guard++) {
        var wa = await until(currentWorkArea, 25000);
        if (!wa) { msg = 'ما رجعت شاشة التحدي بعد الإرسال، توقفت.'; break; }
        var vm = wa.viewModel, ch = vm.getChallenge();
        if ((ch.scoreRequirement || 0) - (ch.submittedScore || 0) <= 0) break;
        prog.set('الدفعة ' + (batches + 1) + ': تحميل بطاقاتك وحساب الأفضل…');
        await loadAll(vm);
        var squad = await squadDefIds(L);
        if (!squad) { msg = 'ما قدرت أقرأ تشكيلتك الفعّالة، توقفت.'; break; }
        var p = await computePlan(L, vm, squad);
        if (!p.ok) { msg = 'ما بقي لاعبون كافون (ينقص ' + (p.shortfall || '?') + ' نقطة).'; break; }
        var batch = p.picked.slice(0, vm.getSelectionLimit() || 30);
        selectBatch(wa, batch);
        if (stop) break;
        var before = ch.submittedScore || 0;
        prog.set('الدفعة ' + (batches + 1) + ': إرسال ' + batch.length + ' لاعب…');
        wa._openReviewScreen();
        var rv = await until(currentReview, 15000);
        if (!rv) { msg = 'ما فتحت شاشة المراجعة (ربما تحذير تشكيلة)، توقفت. التحديد ما زال موجوداً.'; break; }
        rv.submitSelection();
        var ok = await until(function () {
          var w2 = currentWorkArea();
          var c2 = w2 ? w2.viewModel.getChallenge() : ch;
          finished = !!(c2.scoreRequirement && c2.submittedScore >= c2.scoreRequirement);
          return (c2.submittedScore || 0) > before || finished;
        }, 45000);
        if (!ok) { msg = 'ما تأكد لي نجاح الإرسال، توقفت. تحقق من الصفحة.'; break; }
        batches++; sent += batch.length;
        batch.forEach(function (r) {
          spent += r.real; donePts += r.score; doneRating += r.it.rating || 0;
          if (!r.it.tradable) locked += r.real;
          doneRows.push({ cells: [L.name(r.it), String(r.it.rating || 0), String(r.score), L.priceLabel(r.it, r.score), String(batches)] });
        });
        if (finished) break; // challenge completed: the game now shows the rewards, leave it to the user
        await wait(1500);
      }
    } catch (e) {
      msg = String((e && e.message) || e);
    } finally {
      globalThis.__nitroActive = false;
      prog.close();
    }
    var text = 'أُرسلت ' + batches + ' دفعة (' + sent + ' لاعب · ' + donePts + ' نقطة).\nالتكلفة بسعر السوق: ' + L.fmt(spent) + ' كوينز' +
      (locked ? ' (منها ' + L.fmt(locked) + ' لاعبون غير قابلين للبيع)' : '') + '.' + (msg ? '\n\n' + msg : stop ? '\n\nأوقفتَه يدوياً.' : '');
    var title2 = msg ? '⚠ توقف الحل' : '✅ انتهى الحل';
    if (!doneRows.length) { L.showSummary({ ok: false, title: title2, reason: text }); return; }
    L.showSummary({
      ok: true, title: title2, note: msg || '',
      rows: doneRows,
      columns: [{ h: 'اللاعب' }, { h: 'التقييم', k: 'rating' }, { h: 'النقاط', k: 'pts' }, { h: 'السعر · كوينز/نقطة', k: 'price' }, { h: 'دفعة' }],
      totalRow: ['المجموع (' + sent + ' لاعب)', (doneRating / sent).toFixed(1) + ' (متوسط)', String(donePts), L.fmt(spent), String(batches)],
      total: text,
    });
  }

  function addButton() {
    var bar = document.querySelector('.ut-one-click-sbc-work-area-view--toolbar-actions');
    if (!bar || bar.querySelector('.nitro-points-btn')) return;
    var b = document.createElement('button');
    b.className = 'btn-standard nitro-points-btn';
    b.textContent = '⚡ نيترو';
    b.style.cssText = 'background:linear-gradient(135deg,#5cffb0,#2bd4ff);color:#06210f;font-weight:700;margin-inline-start:8px';
    b.addEventListener('click', function () { solve(b); });
    bar.appendChild(b);
  }

  var timer = null;
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () { timer = null; try { addButton(); } catch (e) { /* ignore */ } }, 200);
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
