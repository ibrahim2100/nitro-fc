// Nitro solver layer (runs inside the EA web app page, main world).
// Shared pieces + the hooks that steer Paletools' built-in Smart Builder (normal SBCs):
//   __nitroCmp      candidate ordering   -> lowest market value first, then lowest rating
//   __nitroPrefetch loads market prices for every candidate before it is sorted/filtered
//   __nitroBlocked  expensive players are kept out automatically (relaxed only if nothing else works)
//   __nitroSolve    wraps one Smart Builder run and shows a summary
// Cost = fut.gg market price for EVERY card (also untradeable ones: "what it would have cost").
// Hooks are no-ops unless __nitroActive is set, so nothing else in the app is affected.
(function () {
  var NS = {};
  var priceCache = new Map(); // definitionId -> price (number) | null
  var ratingOf = new Map(); // definitionId -> rating
  var medians = new Map(); // rating -> median known price (used for cards without a price)
  var UNKNOWN = 1e7;
  var DEFAULT_EXPENSIVE = 5000; // coins; 0 disables
  var relax = false;

  // user settings live in localStorage ("nitro:settings"), edited in the in-app Nitro settings page
  var DEFAULTS = { expensive: DEFAULT_EXPENSIVE, playerPenalty: 50 };
  function settings() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem('nitro:settings') || '{}') || {}; } catch (e) { o = {}; }
    var num = function (v, d) { v = Number(v); return Number.isFinite(v) && v >= 0 ? v : d; };
    return { expensive: num(o.expensive, DEFAULTS.expensive), playerPenalty: num(o.playerPenalty, DEFAULTS.playerPenalty) };
  }
  function expensiveLimit() { return settings().expensive; }

  function rebuildMedians() {
    var by = new Map();
    priceCache.forEach(function (p, d) {
      var r = ratingOf.get(d);
      if (p > 0 && r) { if (!by.has(r)) by.set(r, []); by.get(r).push(p); }
    });
    medians = new Map();
    by.forEach(function (arr, r) { arr.sort(function (a, b) { return a - b; }); medians.set(r, arr[arr.length >> 1]); });
  }
  function estimate(it) {
    var r = it.rating || 0, m = null;
    if (medians.has(r)) m = medians.get(r);
    for (var d = 1; m === null && d <= 12; d++) { // nearest rating, higher first (conservative)
      if (medians.has(r + d)) m = medians.get(r + d);
      else if (medians.has(r - d)) m = medians.get(r - d);
    }
    if (m === null) return null;
    return it.rareflag > 1 ? m * 3 : m; // special card without a price: assume it is worth much more
  }
  function known(it) { var p = priceCache.get(it.definitionId); return p > 0 ? p : null; }
  function isEstimated(it) { return known(it) === null; }
  function cost(it) {
    var p = known(it);
    if (p !== null) return p;
    var e = estimate(it);
    return e !== null ? e : UNKNOWN + (it.rating || 0);
  }
  function isBlocked(it, forceRelax) {
    var lim = expensiveLimit();
    return !(forceRelax === undefined ? relax : forceRelax) && lim > 0 && cost(it) >= lim;
  }
  function isStorage(it) {
    try {
      return !!(it.isStorage || (typeof ItemPile !== 'undefined' && (it.pile === ItemPile.STORAGE || it.utasPile === ItemPile.STORAGE)));
    } catch (e) { return false; }
  }
  function name(it) {
    try { return it.getStaticData().getFullName(); } catch (e) { /* fall through */ }
    return '#' + it.definitionId;
  }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function sourceLabel(it) { return isStorage(it) ? 'تخزين SBC' : (it.tradable ? 'النادي' : 'غير قابل للتداول'); }
  function priceLabel(it, pts) {
    var s = (isEstimated(it) ? '~' : '') + fmt(cost(it));
    return pts > 0 ? s + ' · ' + (cost(it) / pts).toFixed(1) + '/ن' : s;
  }

  async function prefetch(items) {
    if (typeof globalThis.__nitroPriceFn !== 'function') return;
    var seen = new Set(), req = [];
    (items || []).forEach(function (it) {
      if (!it || !it.definitionId) return;
      ratingOf.set(it.definitionId, it.rating || 0);
      if (priceCache.has(it.definitionId) || seen.has(it.definitionId)) return;
      seen.add(it.definitionId);
      req.push({ definitionId: it.definitionId, isPlayer: function () { return true; } });
    });
    if (req.length) {
      try {
        var res = (await globalThis.__nitroPriceFn(req)) || {};
        req.forEach(function (r) {
          var e = res[r.definitionId];
          priceCache.set(r.definitionId, e && e.price > 0 ? e.price : null);
        });
      } catch (e) { /* prices unavailable: fall back to rating-based estimates */ }
    }
    rebuildMedians();
  }
  globalThis.__nitroPrefetch = async function (items) {
    if (!globalThis.__nitroActive) return;
    return prefetch(items);
  };

  globalThis.__nitroCmp = function (a, b) {
    if (!globalThis.__nitroActive || !a || !b) return 0;
    var d = cost(a) - cost(b);
    if (d) return d < 0 ? -1 : 1;
    d = (a.rating || 0) - (b.rating || 0);
    return d ? (d < 0 ? -1 : 1) : 0;
  };
  globalThis.__nitroBlocked = function (it) { return !!globalThis.__nitroActive && !!it && isBlocked(it); };

  // ---------- UI ----------
  function overlay() {
    var wrap = document.createElement('div');
    wrap.id = 'nitro-summary';
    wrap.setAttribute('dir', 'rtl');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(5,10,20,.72);display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Tahoma,sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'background:#0b1220;color:#eaf2ff;border:1px solid #2bd4ff55;border-radius:14px;width:min(560px,92vw);max-height:86vh;overflow:auto;padding:16px 18px;box-shadow:0 10px 40px #000a';
    wrap.appendChild(box);
    return { wrap: wrap, box: box };
  }
  function mkBtn(label, bg, fg) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin-top:10px;width:100%;padding:10px;border:0;border-radius:10px;background:' + bg + ';color:' + fg + ';font-weight:700;cursor:pointer;font-size:14px';
    return b;
  }

  function showSummary(info) {
    var old = document.getElementById('nitro-summary');
    if (old) old.remove();
    var o = overlay(), box = o.box, wrap = o.wrap;
    var h = document.createElement('div');
    h.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:4px';
    h.textContent = info.title || (info.ok ? '⚡ ملخص حل نيترو' : '⚠ تعذّر الحل');
    box.appendChild(h);
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:#8ea3c7;margin-bottom:10px;white-space:pre-line';
    sub.textContent = info.note || '';
    box.appendChild(sub);
    if (info.ok) {
      var cols = info.columns || [{ h: 'اللاعب' }, { h: 'التقييم', k: 'rating' }, { h: 'المصدر' }, { h: 'السعر', k: 'price' }];
      var data = (info.rows || []).map(function (r) { return r.cells || [r.name, String(r.rating), r.source, r.price]; });
      var tbl = document.createElement('table');
      tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px';
      var cellCss = function (k, head) {
        return 'padding:6px 5px;' + (head ? 'font-size:11px;color:#8ea3c7;font-weight:600;' : '') +
          (k === 'rating' ? 'font-weight:700;color:#ffe45c;text-align:center;' : '') +
          (k === 'pts' ? 'text-align:center;color:#9bd0ff;' : '') +
          (k === 'price' ? 'text-align:left;direction:ltr;color:#5cffb0;white-space:nowrap;' : '');
      };
      var addRow = function (cells, extraCss, head) {
        var tr = document.createElement('tr');
        tr.style.cssText = extraCss || 'border-top:1px solid #ffffff1a';
        cells.forEach(function (t, i) {
          var td = document.createElement(head ? 'th' : 'td');
          td.style.cssText = cellCss(cols[i] && cols[i].k, head) + (head ? 'text-align:' + (cols[i] && cols[i].k ? 'center' : 'right') + ';' : '');
          td.textContent = t;
          tr.appendChild(td);
        });
        tbl.appendChild(tr);
      };
      addRow(cols.map(function (c) { return c.h; }), 'border-bottom:1px solid #ffffff33', true);
      data.forEach(function (cells) { addRow(cells); });
      if (info.totalRow) addRow(info.totalRow, 'border-top:2px solid #2bd4ff88;font-weight:800;background:#ffffff0d');
      box.appendChild(tbl);
      var tot = document.createElement('div');
      tot.style.cssText = 'margin-top:10px;font-weight:700;color:#5cffb0;white-space:pre-line';
      tot.textContent = info.total || '';
      box.appendChild(tot);
      var copy = mkBtn('نسخ الملخص', '#1d3257', '#eaf2ff');
      copy.onclick = function () {
        var lines = [h.textContent, ''].concat([cols.map(function (c) { return c.h; }).join('\t')], data.map(function (c) { return c.join('\t'); }));
        if (info.totalRow) lines.push(info.totalRow.join('\t'));
        lines.push('', info.total || '');
        try { navigator.clipboard.writeText(lines.join('\n')); copy.textContent = 'تم النسخ ✓'; } catch (e) { copy.textContent = 'تعذّر النسخ'; }
      };
      box.appendChild(copy);
    } else {
      var rs = document.createElement('div');
      rs.style.whiteSpace = 'pre-line';
      rs.textContent = info.reason || '';
      box.appendChild(rs);
    }
    (info.actions || []).forEach(function (a) {
      var b = mkBtn(a.label, '#ffe45c', '#2b2100');
      var armed = false;
      b.onclick = function () {
        if (a.confirm && !armed) { armed = true; b.textContent = a.confirm; b.style.background = '#ff8a2b'; return; }
        wrap.remove();
        a.onClick();
      };
      box.appendChild(b);
    });
    var close = mkBtn('إغلاق', '#2bd4a0', '#06210f');
    close.onclick = function () { wrap.remove(); };
    box.appendChild(close);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  // small status overlay with a stop button (used while submitting several batches)
  function showProgress(text, onStop, stopLabel) {
    var old = document.getElementById('nitro-summary');
    if (old) old.remove();
    var o = overlay();
    var t = document.createElement('div');
    t.style.cssText = 'font-size:15px;font-weight:700;white-space:pre-line';
    t.textContent = text;
    o.box.appendChild(t);
    var stop = mkBtn(stopLabel || 'إيقاف بعد الدفعة الحالية', '#ff8a2b', '#2b1200');
    stop.onclick = function () { stop.disabled = true; stop.textContent = stopLabel ? 'جارٍ الإنهاء…' : 'سيتوقف بعد الدفعة الحالية…'; onStop(); };
    o.box.appendChild(stop);
    document.body.appendChild(o.wrap);
    return { set: function (s) { t.textContent = s; }, close: function () { o.wrap.remove(); } };
  }

  function observe(obs) {
    return new Promise(function (res, rej) {
      obs.observe(NS, function (sender, r) {
        sender.unobserve(NS);
        r && r.success ? res(r) : rej(new Error(r && r.error));
      });
    });
  }

  function totals(players) {
    var all = 0, locked = 0, est = 0;
    players.forEach(function (it) {
      var c = cost(it);
      all += c;
      if (!it.tradable) locked += c;
      if (isEstimated(it)) est++;
    });
    return { all: all, locked: locked, est: est };
  }
  function costLine(t, n) {
    return 'التكلفة بسعر السوق: ' + fmt(t.all) + ' كوينز — ' + n + ' لاعب' +
      (t.locked ? '\nمنها ' + fmt(t.locked) + ' كوينز لاعبون غير قابلين للبيع (محسوبة بسعر السوق)' : '') +
      (t.est ? '\n(~) ' + t.est + ' بطاقة بلا سعر مباشر: قيمتها تقديرية' : '');
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Requirements that are still unmet, as shown by the game ("Nationalities in Squad: Min. 5 (0)").
  function unmetRequirements(challenge) {
    try {
      var lis = document.querySelectorAll('.sbc-requirements-checklist li');
      if (lis.length) {
        return Array.prototype.filter.call(lis, function (li) { return !li.classList.contains('complete'); })
          .map(function (li) { return li.textContent.trim(); }).filter(Boolean);
      }
    } catch (e) { /* fall through */ }
    try {
      var reqs = challenge.eligibilityRequirements || [];
      var out = [];
      reqs.forEach(function (r, i) { if (!challenge.isRequirementMet(r)) out.push('الشرط رقم ' + (i + 1)); });
      return out;
    } catch (e) { return []; }
  }

  // Puts a (possibly incomplete) result into the squad, like the builder does for a full solution.
  async function placeInSquad(challenge, players) {
    var arr = new Array(UTSquadEntity.TOTAL_PLAYERS);
    var slots = challenge.squad.getNonBrickSlots();
    for (var i = 0; i < players.length; i++) {
      var slot = slots.shift();
      if (!slot) break;
      arr[slot.index] = players[i];
    }
    challenge.squad.setPlayers(arr);
    try { await observe(services.SBC.saveChallenge(challenge)); } catch (e) { /* the squad is still filled on screen */ }
  }

  function buildInfo(res, ctx) {
    ctx = ctx || {};
    var lim = expensiveLimit();
    var note = (ctx.protectedCount != null ? 'استُبعدت تشكيلتك الفعّالة (' + ctx.protectedCount + ' لاعب) واللاعبون المقفلون. ' : 'استُبعدت تشكيلتك الفعّالة واللاعبون المقفلون. ') +
      (lim > 0 ? (ctx.relaxed ? 'لم يكفِ الحل بدون اللاعبين الغالين (≥ ' + fmt(lim) + ') فاستُخدم بعضهم. ' : 'استُبعد تلقائياً أي لاعب سعره ≥ ' + fmt(lim) + ' كوينز. ') : '') +
      'الاختيار: الأقل تكلفة ثم الأقل تقييماً.';
    var players = ((res && res.players) || []).filter(Boolean);
    var unmet = ctx.unmet || [];
    if (!players.length) {
      return { ok: false, title: '⚠ تعذّر الحل', note: note, reason: 'ما لقيت أي تشكيلة تقترب من الشروط بالمتوفر عندك.' + (unmet.length ? '\nالشروط:\n• ' + unmet.join('\n• ') : '') + '\nجرّب «بحث» داخل التحدي لشراء اللاعبين الناقصين.' };
    }
    var rows = players.map(function (it) {
      var need = !!it.concept;
      return { name: name(it), rating: it.rating || 0, source: need ? 'تحتاج شراء' : sourceLabel(it), price: priceLabel(it), _c: cost(it), _need: need };
    });
    rows.sort(function (a, b) { return (b._need - a._need) || b._c - a._c || b.rating - a.rating; });
    var tt = totals(players.filter(function (it) { return !it.concept; }));
    var buy = players.filter(function (it) { return it.concept; });
    var tb = totals(buy);
    var avg = (players.reduce(function (a, it) { return a + (it.rating || 0); }, 0) / players.length).toFixed(1);
    var text = costLine(totals(players), players.length);
    if (buy.length) {
      text += '\n\n🛒 ينقصك ' + buy.length + ' بطاقة، أفضل خيار تشتريه (الأرخص بسعر السوق): إجمالي ' + fmt(tb.all) + ' كوينز\n' +
        buy.map(function (it) { return '• ' + name(it) + ' (' + (it.rating || 0) + ') ≈ ' + priceLabel(it); }).join('\n');
    }
    var out = { ok: true, note: note, rows: rows, totalRow: ['المجموع (' + rows.length + ' لاعب)', avg + ' (متوسط)', '', fmt(totals(players).all)], total: text };
    if (ctx.partial) {
      out.title = '⚠ حل جزئي: ما كفى المتوفر';
      out.note = 'وضعت أفضل ما عندك في التشكيلة، لكن ما تحقق كل الشروط.\n' + note;
      out.total = text + '\n\n❌ الشروط الناقصة:\n' + (unmet.length ? '• ' + unmet.join('\n• ') : '• راجع قائمة الشروط في الصفحة') +
        (buy.length ? '' : '\n\n💡 أرخص حل: اشترِ لاعباً/لاعبين يحققون هذه الشروط (من «بحث» داخل التحدي) ثم اضغط الزر مرة ثانية.');
    } else if (buy.length) {
      out.title = '⚡ ملخص حل نيترو (مع بطاقات تحتاج شراء)';
    }
    return out;
  }

  // ---- summary of the full SBC solver (tools/nitro/sbc.js)
  // modelOk: per-requirement booleans from the solver's own model (used when the game cannot judge the
  // squad, e.g. it still contains cards to buy); otherwise the game's own verdict is used.
  function requirementLines(challenge, modelOk) {
    var texts = [];
    try {
      var lists = document.querySelectorAll('.sbc-requirements-checklist');
      var last = lists[lists.length - 1];
      if (last) texts = Array.prototype.map.call(last.children, function (li) { return li.textContent.trim(); });
    } catch (e) { /* texts are optional */ }
    var reqs = challenge.eligibilityRequirements || [];
    var lines = [];
    reqs.forEach(function (r, i) {
      var ok;
      if (modelOk) ok = !!modelOk[i];
      else { try { ok = !!challenge.isRequirementMet(r); } catch (e) { ok = false; } }
      lines.push({ ok: ok, text: texts[i] || ('الشرط رقم ' + (i + 1)) });
    });
    // checklist entries that are not requirement objects (e.g. "Number of Players in the Squad: 11")
    var full = true;
    try { full = challenge.squad.getFieldPlayers().every(function (sl) { return sl.item && sl.item.id > 0; }); } catch (e) { /* ignore */ }
    for (var j = reqs.length; j < texts.length; j++) lines.push({ ok: full, text: texts[j] });
    return lines;
  }

  function buildInfoSbc(mine, ctx, challenge) {
    var players = mine.players.filter(Boolean);
    var lim = expensiveLimit();
    var d = mine.describe || { rows: [], rating: 0, chem: 0 };
    var buy = players.filter(function (it) { return it.concept || it.isConceptPlayer; });
    var owned = players.filter(function (it) { return !(it.concept || it.isConceptPlayer); });
    var tOwned = totals(owned), tBuy = totals(buy);
    var avg = players.length ? (players.reduce(function (a, it) { return a + (it.rating || 0); }, 0) / players.length).toFixed(1) : '0';
    var lines = requirementLines(challenge, buy.length ? d.reqOk : undefined);
    var gameDisagrees = mine.success && !buy.length && lines.some(function (l) { return !l.ok; });
    if (gameDisagrees && mine.reqDiag) lines.forEach(function (l, i) { if (!l.ok && mine.reqDiag[i]) l.text += '  [' + mine.reqDiag[i] + ']'; });
    var reqText = lines.map(function (l) { return (l.ok ? '✅ ' : '❌ ') + l.text; }).join('\n');
    var text = 'التقييم: ' + d.rating + ' · الكيميستري: ' + d.chem + '\n' +
      'قيمة لاعبيك المستخدمين (سعر السوق): ' + fmt(tOwned.all) + ' كوينز (' + owned.length + ' لاعب' + (tOwned.locked ? '، منها ' + fmt(tOwned.locked) + ' غير قابلة للبيع' : '') + ')';
    if (buy.length) {
      text += '\n\n🛒 ينقصك ' + buy.length + ' بطاقة (الأرخص بسعر السوق)، إجمالي الشراء ≈ ' + fmt(tBuy.all) + ' كوينز\n' +
        buy.map(function (it) { return '• ' + name(it) + ' (' + (it.rating || 0) + ') ≈ ' + priceLabel(it); }).join('\n');
    }
    text += '\n\nالشروط:\n' + reqText;
    var out = {
      ok: true,
      title: gameDisagrees ? '⚠ اللعبة ترى شرطاً غير محقق' : mine.success ? (buy.length ? '🛒 حل نيترو: يلزم شراء بطاقات' : '⚡ ملخص حل نيترو') : '⚠ حل جزئي: ما كفى المتوفر',
      note: 'الأولوية لناديك ثم الشراء. ' + (ctx.protectedCount != null ? 'استُبعدت تشكيلتك الفعّالة (' + ctx.protectedCount + ' لاعب). ' : '') +
        (lim > 0 ? (mine.usedExpensive ? 'لم يكفِ الحل بدون اللاعبين الغالين (≥ ' + fmt(lim) + ') فاستُخدم بعضهم. ' : 'استُبعد تلقائياً أي لاعب سعره ≥ ' + fmt(lim) + ' كوينز. ') : '') +
        (gameDisagrees ? 'حسب لعبة EA بعض الشروط غير محققة، راجع ❌ بالأسفل. ' : mine.success ? (buy.length ? 'الشروط محققة بعد شراء البطاقات المذكورة. ' : 'كل الشروط محققة حسب لعبة EA. ') : 'وضعت أفضل ما عندك؛ الناقص موضّح بالأسفل. ') +
        (mine.repaired ? 'اللعبة رفضت الحل الأول فأعدت البحث بحكمها حتى قبلته. ' : '') + (mine.verified === false ? 'جرّبت 12 حلاً + إصلاحاً ولعبة EA ما قبلت؛ أرسل لي لقطة من هذا الملخص.' : ''),
      columns: [{ h: 'المركز' }, { h: 'اللاعب' }, { h: 'التقييم', k: 'rating' }, { h: 'المصدر' }, { h: 'السعر', k: 'price' }],
      rows: d.rows,
      totalRow: ['المجموع (' + players.length + ')', '', avg + ' (متوسط)', '', fmt(tOwned.all + tBuy.all)],
      total: text,
    };
    return out;
  }

  // run(extra?) => Promise<{success, players, reason}>  (the original Smart Builder call; extra = config overrides)
  globalThis.__nitroSolve = async function (run, challenge) {
    globalThis.__nitroActive = true;
    relax = false;
    var ctx = { protectedCount: null, relaxed: false, partial: false, unmet: [], squadDefs: [], squadOk: false }, res, returned, mine = null;
    try {
      try {
        var r = await observe(new UTItemSearchViewModel().requestActiveSquadDefIds());
        ctx.squadDefs = r.data && r.data.defIds ? r.data.defIds : [];
        ctx.protectedCount = ctx.squadDefs.length;
        ctx.squadOk = true;
      } catch (e) { /* informational only */ }

      // 1) the full solver: all requirements, club first, then buying
      if (challenge && globalThis.__nitroSbc && ctx.squadOk) {
        try { mine = await globalThis.__nitroSbc.solve(challenge, ctx); } catch (e) { mine = null; }
      }
      if (mine) {
        returned = { success: mine.success, players: mine.players, reason: 'حل جزئي: راجع ملخص نيترو' };
        if (!mine.success && mine.players.length) {
          try { await placeInSquad(challenge, mine.players.filter(Boolean)); await wait(900); } catch (e) { /* summary still shown */ }
        }
        try { await prefetch(mine.players.filter(Boolean)); } catch (e) { /* prices are optional */ }
        setTimeout(function () {
          try { showSummary(buildInfoSbc(mine, ctx, challenge)); } catch (e) { showSummary({ ok: false, title: '⚠ تعذّر عرض الملخص', reason: String((e && e.message) || e) }); }
        }, mine.success ? 1500 : 350);
        return returned;
      }

      // 2) the builder's own engine (used only when the challenge is not supported above)
      res = await run();
      if ((!res || !res.success) && expensiveLimit() > 0) { // nothing without the expensive ones: allow them
        relax = true; ctx.relaxed = true;
        res = await run();
      }
      if (!res || !res.success) { // not enough in the club: let the builder pick missing (unowned) cards too
        try {
          var r2 = await run({ includeConceptPlayers: true });
          var n1 = ((res && res.players) || []).length, n2 = ((r2 && r2.players) || []).length;
          if (r2 && (r2.success || n2 > n1)) res = r2;
        } catch (e) { /* keep the club-only result */ }
      }
      returned = res;
      if (res && !res.success && res.players && res.players.length && challenge) {
        ctx.partial = true;
        try { await placeInSquad(challenge, res.players.filter(Boolean)); await wait(900); } catch (e) { /* summary still shown */ }
        ctx.unmet = unmetRequirements(challenge);
        returned = { success: false, players: res.players, reason: 'حل جزئي: راجع ملخص نيترو' };
      } else if (res && !res.success && challenge) {
        ctx.unmet = unmetRequirements(challenge);
      }
      try { await prefetch((res && res.players) || []); } catch (e) { /* prices are optional */ }
    } finally {
      globalThis.__nitroActive = false;
      relax = false;
    }
    if (!mine) { try { setTimeout(function () { showSummary(buildInfo(res, ctx)); }, 350); } catch (e) { /* never break the builder */ } }
    return returned;
  };

  globalThis.__nitroLib = {
    showSummary: showSummary, showProgress: showProgress, prefetch: prefetch, cost: cost, isEstimated: isEstimated,
    isBlocked: isBlocked, expensiveLimit: expensiveLimit, settings: settings, isStorage: isStorage, name: name, fmt: fmt,
    sourceLabel: sourceLabel, priceLabel: priceLabel, totals: totals, costLine: costLine, observe: observe, UNKNOWN: UNKNOWN,
  };
})();
