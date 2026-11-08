// Nitro settings page: re-groups the ~60 plugin cards of the in-app settings into categories,
// adds search + a card for the Nitro solver options, and restyles everything.
// It only moves / styles the existing Paletools cards (their toggles keep working); cards it does
// not know land in "أخرى", so new upstream plugins never disappear.
(function () {
  if (typeof document === 'undefined') return;

  var CATS = [
    { id: 'nitro', name: 'نيترو', icon: '⚡' },
    { id: 'sbc', name: 'SBC', icon: '🧩' },
    { id: 'market', name: 'السوق والأسعار', icon: '💰' },
    { id: 'club', name: 'النادي واللاعبون', icon: '🏟️' },
    { id: 'packs', name: 'الباكات', icon: '📦' },
    { id: 'ui', name: 'الواجهة', icon: '🎨' },
    { id: 'auto', name: 'أتمتة · خطر الحظر', icon: '⚠️' },
    { id: 'other', name: 'أخرى', icon: '⋯' },
  ];
  var MAP = {
    sbc: ['hideSbcs', 'sbc-times-completed', 'add-multiple-players-to-squad', 'repeat-sbc', 'select-cheapest', 'import-sbc',
      'duplicated-to-sbc', 'unassigned-to-sbc', 'transfer-list-to-sbc', 'sbc-smart-builder', 'sbc-challenges-view', 'filterSbcs',
      'sbc-rating-calculator', 'sbc-template-builder', 'lock-players', 'sbc-auto-solver', 'sbc-builder-enhacer'],
    market: ['external-market-prices', 'lowest-market-price', 'priceTracker', 'compare-min-max-prices', 'sell-profit',
      'keep-player-sell-values', 'track-transactions', 'market-search-filters', 'improved-filters', 'improved-player-search', 'refresh-coins'],
    club: ['player-actions', 'player-card-info', 'mark-duplicated', 'club-pager', 'club-index', 'club-analyzer', 'club-search-enhacer',
      'bench-management', 'hidden-injury', 'decimalRating', 'gradingScore', 'important-leagues', 'unassigned-organize',
      'unassigned-goback', 'transer-list-send-all-to-club', 'album', 'gallery', 'player-picks'],
    packs: ['my-packs', 'countMyPacks', 'disablePackAnimations', 'goToPackStore'],
    ui: ['remove-rounded-corners', 'remove-exchange-players-button', 'whatsnew'],
    auto: ['auto-relist', 'sell-multiple', 'packs-opener', 'babysitter', 'claimObjectives', 'claim-sbc-rewards'],
  };
  var HIDE = ['checkForUpdates']; // needs pale.tools, which this build blocks
  var catOf = {};
  Object.keys(MAP).forEach(function (c) { MAP[c].forEach(function (id) { catOf[id] = c; }); });

  var CSS = [
    '.nitro-settings{grid-column:1/-1;display:block;direction:rtl;color:#eaf2ff;font-family:inherit;--n-bg:#0f1b33;--n-card:#132340;--n-line:#ffffff18;--n-acc:#2bd4ff;--n-acc2:#5cffb0;--n-mut:#8ea3c7}',
    '.nitro-settings .ns-top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:4px 0 14px}',
    '.nitro-settings .ns-title{font-size:22px;font-weight:800;background:linear-gradient(90deg,var(--n-acc2),var(--n-acc));-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.nitro-settings .ns-sub{font-size:12px;color:var(--n-mut)}',
    '.nitro-settings .ns-search{flex:1 1 220px;max-width:360px;background:var(--n-bg);color:#eaf2ff;border:1px solid var(--n-line);border-radius:12px;padding:10px 14px;font-size:14px;outline:none}',
    '.nitro-settings .ns-search:focus{border-color:var(--n-acc)}',
    '.nitro-settings .ns-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}',
    '.nitro-settings .ns-tab{background:var(--n-bg);color:#cfe0ff;border:1px solid var(--n-line);border-radius:999px;padding:8px 14px;font-size:13px;cursor:pointer;white-space:nowrap}',
    '.nitro-settings .ns-tab b{display:inline-block;direction:ltr;font-weight:700;color:var(--n-mut);margin:0 6px;font-size:11px}',
    '.nitro-settings .ns-tab.on{background:linear-gradient(135deg,var(--n-acc2),var(--n-acc));color:#06210f;border-color:transparent;font-weight:700}',
    '.nitro-settings .ns-tab.on b{color:#06210fb0}',
    '.nitro-settings .ns-tab.warn:not(.on){border-color:#ff8a2b88;color:#ffc58f}',
    '.nitro-settings .ns-note{background:#ff8a2b1a;border:1px solid #ff8a2b66;color:#ffd9b3;border-radius:12px;padding:10px 14px;font-size:13px;margin-bottom:14px}',
    '.nitro-settings .ns-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;align-items:start}',
    '.nitro-settings .ns-empty{color:var(--n-mut);padding:30px;text-align:center;grid-column:1/-1}',
    '.nitro-settings .settings-container{grid-column:auto !important;width:auto !important;margin:0 !important;background:var(--n-card) !important;border:1px solid var(--n-line);border-radius:16px;padding:0 !important;overflow:hidden}',
    '.nitro-settings .settings-container>header{padding:12px 16px !important;border-bottom:1px solid var(--n-line);display:flex;align-items:center;justify-content:space-between;gap:8px;background:#ffffff08}',
    '.nitro-settings .settings-container h3{margin:0 !important;padding:0 !important;line-height:1.5 !important;font-size:15px !important;font-weight:700}',
    '.nitro-settings .settings-container>header{box-sizing:border-box;height:auto}',
    '.nitro-settings .settings-container h3 a{color:inherit !important;text-decoration:none}',
    '.nitro-settings .settings-container>div{padding:6px 16px 10px}',
    '.nitro-settings .go-to-top{display:none !important}',
    '.nitro-settings .ns-single{position:relative}',
    '.nitro-settings .ns-single>div{position:absolute;top:0;bottom:0;left:16px;padding:0 !important;display:flex;align-items:center}',
    '.nitro-settings .ns-single>div .ut-label-with-toggle{border:0 !important;padding:0 !important}',
    '.nitro-settings .ns-single>div label{display:none !important}',
    '.nitro-settings .ns-single .ns-badge{display:none}',
    '.nitro-settings .ns-single .ut-toggle-control{margin:0 !important}',
    '.nitro-settings .ns-single>header{min-height:48px;padding-inline-end:76px !important}',
    '.nitro-settings .ut-label-with-toggle{display:flex !important;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--n-line)}',
    '.nitro-settings .ut-label-with-toggle:last-child{border-bottom:0}',
    '.nitro-settings .ut-label-with-toggle label{font-size:13px;color:#dbe7ff;flex:1}',
    '.nitro-settings .ns-badge{font-size:11px;padding:3px 8px;border-radius:999px;background:#ffffff14;color:var(--n-mut);white-space:nowrap}',
    '.nitro-settings .ns-badge.some{background:#2bd4a033;color:var(--n-acc2)}',
    '.nitro-settings .ns-field{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--n-line)}',
    '.nitro-settings .ns-field:last-child{border-bottom:0}',
    '.nitro-settings .ns-field span{font-size:13px;color:#dbe7ff;flex:1}',
    '.nitro-settings .ns-field small{display:block;color:var(--n-mut);font-size:11px;margin-top:2px}',
    '.nitro-settings .ns-field input{width:96px;background:var(--n-bg);color:#eaf2ff;border:1px solid var(--n-line);border-radius:10px;padding:8px;font-size:14px;direction:ltr;text-align:center}',
    '.nitro-settings .ns-field input:focus{border-color:var(--n-acc);outline:none}',
    '.nitro-settings .ns-help{font-size:12px;color:var(--n-mut);line-height:1.7;padding:8px 0 2px}',
    '.paletools-settings-wrapper>.jump-menu,.paletools-settings-wrapper>a#plugins-top{display:none !important}',
  ].join('\n');

  function readSettings() {
    try { return JSON.parse(localStorage.getItem('nitro:settings') || '{}') || {}; } catch (e) { return {}; }
  }
  function writeSetting(key, value) {
    var o = readSettings();
    o[key] = value;
    try { localStorage.setItem('nitro:settings', JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  }

  function nitroCard() {
    var card = document.createElement('div');
    card.className = 'tile col-1-1 settings-container nitro-card';
    card.id = 'paletools-settings-nitro-solver-container';
    var head = document.createElement('header');
    var h = document.createElement('h3');
    h.className = 'tileHeader';
    h.textContent = '⚡ الحل الذكي (SBC)';
    head.appendChild(h);
    card.appendChild(head);
    var body = document.createElement('div');
    var cur = readSettings();
    [
      { key: 'expensive', label: 'حد اللاعب الغالي (كوينز)', hint: 'أي لاعب سعره فوق هذا الحد يُستبعد تلقائياً. 0 = بدون استبعاد', def: 5000, step: 500 },
      { key: 'playerPenalty', label: 'أفضلية قلة اللاعبين (كوينز)', hint: 'كل لاعب زيادة يجب أن يوفّر أكثر من هذا المبلغ. كبّره للحصول على لاعبين أقل', def: 50, step: 25 },
    ].forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'ns-field';
      var span = document.createElement('span');
      span.textContent = f.label;
      var small = document.createElement('small');
      small.textContent = f.hint;
      span.appendChild(small);
      var inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = String(f.step);
      inp.value = cur[f.key] !== undefined ? cur[f.key] : f.def;
      inp.addEventListener('change', function () {
        var n = Math.max(0, Math.round(Number(inp.value) || 0));
        inp.value = n;
        writeSetting(f.key, n);
      });
      row.appendChild(span);
      row.appendChild(inp);
      body.appendChild(row);
    });
    var help = document.createElement('div');
    help.className = 'ns-help';
    help.textContent = 'التكلفة تُحسب بسعر السوق لكل بطاقة حتى غير القابلة للبيع. يُستبعد دائماً: تشكيلتك الفعّالة والمعارون. زر «⚡ نيترو» يظهر داخل التحدي.';
    body.appendChild(help);
    card.appendChild(body);
    return card;
  }

  function cardId(el) { return el.id.replace('paletools-settings-', '').replace('-container', ''); }
  function togglesOf(card) {
    var all = card.querySelectorAll('.ut-toggle-control');
    return { on: card.querySelectorAll('.ut-toggle-control.toggled').length, total: all.length };
  }
  function updateBadge(card) {
    var b = card.querySelector('.ns-badge');
    var t = togglesOf(card);
    if (!b || !t.total) return;
    b.textContent = t.on + '/' + t.total + ' مفعّل';
    b.className = 'ns-badge' + (t.on ? ' some' : '');
  }

  function build(wrapper) {
    var cards = Array.prototype.slice.call(wrapper.querySelectorAll('.settings-container')).filter(function (c) { return !c.classList.contains('nitro-card'); });
    var sig = cards.map(cardId).join('|');
    if (wrapper.getAttribute('data-nitro-sig') === sig && wrapper.querySelector('.nitro-settings')) return;
    wrapper.setAttribute('data-nitro-sig', sig);

    if (!document.getElementById('nitro-settings-css')) {
      var st = document.createElement('style');
      st.id = 'nitro-settings-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var old = wrapper.querySelector('.nitro-settings');
    if (old) old.remove();

    var groups = {};
    CATS.forEach(function (c) { groups[c.id] = []; });
    var nCard = wrapper.querySelector('.nitro-card') || nitroCard();
    groups.nitro.push(nCard);
    cards.forEach(function (card) {
      var id = cardId(card);
      if (HIDE.indexOf(id) !== -1) { card.style.display = 'none'; return; }
      if (!card.querySelector('.ns-badge')) {
        var hd = card.querySelector('header');
        if (hd) { var bd = document.createElement('span'); bd.className = 'ns-badge'; hd.appendChild(bd); }
      }
      updateBadge(card);
      var body = card.querySelector(':scope > div');
      if (body && body.children.length === 1 && body.children[0].classList.contains('ut-label-with-toggle')) card.classList.add('ns-single');
      groups[catOf[id] || 'other'].push(card);
    });

    var root = document.createElement('div');
    root.className = 'nitro-settings';
    root.setAttribute('dir', 'rtl');

    var top = document.createElement('div');
    top.className = 'ns-top';
    var ttl = document.createElement('div');
    var h = document.createElement('div');
    h.className = 'ns-title';
    h.textContent = '⚡ إعدادات نيترو';
    var sub = document.createElement('div');
    sub.className = 'ns-sub';
    var total = 0, enabled = 0;
    cards.forEach(function (c) { var t = togglesOf(c); total += t.total; enabled += t.on; });
    sub.textContent = (cards.length - HIDE.length) + ' ميزة · ' + enabled + ' خيار مفعّل';
    ttl.appendChild(h); ttl.appendChild(sub);
    var search = document.createElement('input');
    search.className = 'ns-search';
    search.type = 'search';
    search.placeholder = 'ابحث في الإعدادات…';
    top.appendChild(ttl); top.appendChild(search);
    root.appendChild(top);

    var tabs = document.createElement('div');
    tabs.className = 'ns-tabs';
    root.appendChild(tabs);
    var noteEl = document.createElement('div');
    noteEl.className = 'ns-note';
    noteEl.textContent = 'تنبيه: ميزات الأتمتة تنفّذ إجراءات بدل اللاعب وتزيد خطر حظر الحساب من EA. اتركها مطفية إلا إذا كنت تعرف ما تفعل.';
    noteEl.style.display = 'none';
    root.appendChild(noteEl);
    var grid = document.createElement('div');
    grid.className = 'ns-grid';
    root.appendChild(grid);
    var store = document.createElement('div');
    store.style.display = 'none';
    root.appendChild(store);
    cards.concat([nCard]).forEach(function (c) { store.appendChild(c); });

    var active = 'nitro';
    try { active = localStorage.getItem('nitro:settings-tab') || 'nitro'; } catch (e) { /* ignore */ }
    if (!groups[active] || !groups[active].length) active = 'nitro';

    function render() {
      var q = search.value.trim().toLowerCase();
      tabs.innerHTML = '';
      CATS.forEach(function (c) {
        if (!groups[c.id].length) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ns-tab' + (!q && c.id === active ? ' on' : '') + (c.id === 'auto' ? ' warn' : '');
        b.innerHTML = '';
        b.appendChild(document.createTextNode(c.icon + ' ' + c.name));
        var n = document.createElement('b');
        n.textContent = String(groups[c.id].length);
        b.appendChild(n);
        b.onclick = function () {
          active = c.id; search.value = '';
          try { localStorage.setItem('nitro:settings-tab', active); } catch (e) { /* ignore */ }
          render();
        };
        tabs.appendChild(b);
      });
      var shown = 0;
      Array.prototype.slice.call(grid.children).forEach(function (el) {
        if (el.classList.contains('ns-empty')) grid.removeChild(el); else store.appendChild(el);
      });
      CATS.forEach(function (c) {
        groups[c.id].forEach(function (card) {
          var match = q ? card.textContent.toLowerCase().indexOf(q) !== -1 : c.id === active;
          if (match) { grid.appendChild(card); shown++; }
        });
      });
      noteEl.style.display = !q && active === 'auto' ? 'block' : 'none';
      if (!shown) {
        var e = document.createElement('div');
        e.className = 'ns-empty';
        e.textContent = 'لا توجد نتائج.';
        grid.appendChild(e);
      }
    }
    search.addEventListener('input', render);
    grid.addEventListener('click', function () {
      setTimeout(function () { cards.forEach(updateBadge); }, 80);
    });

    // cards hidden by the filter wait here (inside the wrapper) so they are never lost
    wrapper.appendChild(root);
    render();
  }

  var timer = null;
  function scan() {
    timer = null;
    var w = document.querySelector('.paletools-settings-wrapper');
    if (!w || !w.querySelector('.settings-container')) return;
    try { build(w); } catch (e) { /* never break the page: the original list stays usable */ }
  }
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(scan, 200);
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
