(function () {
  'use strict';

  var root = document.getElementById('board');
  var data = window.RADAR;

  if (!root || !data || !Array.isArray(data.rows)) {
    if (root) {
      root.innerHTML = '<div class="empty-state">Missing radar dataset (data.js).</div>';
    }
    return;
  }

  var rows = data.rows;
  var meta = data.meta;
  var bySlug = new Map();
  for (var i = 0; i < rows.length; i++) {
    bySlug.set(rows[i].slug, rows[i]);
  }

  var totalImplied = rows.reduce(function (acc, r) {
    return acc + r.implied_value_usd;
  }, 0);

  // Build category and chain lists with counts for selects.
  var catCounts = new Map();
  var chainCounts = new Map();
  for (var j = 0; j < rows.length; j++) {
    var catName = rows[j].category || 'Uncategorized';
    catCounts.set(catName, (catCounts.get(catName) || 0) + 1);
    for (var c = 0; c < rows[j].chains.length; c++) {
      var ch = rows[j].chains[c];
      chainCounts.set(ch, (chainCounts.get(ch) || 0) + 1);
    }
  }

  var categories = Array.from(catCounts.entries()).sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  var chains = Array.from(chainCounts.entries()).sort(function (a, b) {
    return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  });

  var state = {
    q: '',
    cat: '',
    chain: '',
    watch: false,
    sort: 'rank',
    dir: 'asc',
    p: ''
  };

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtUsd(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    var abs = Math.abs(n);
    if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function fmtWholeUsd(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function fmtChange(v) {
    if (v === null || v === undefined || !isFinite(v)) {
      return { text: '-', cls: 'chg-flat' };
    }
    var sign = v > 0 ? '+' : '';
    var cls = v > 0.05 ? 'chg-pos' : v < -0.05 ? 'chg-neg' : 'chg-flat';
    return { text: sign + v.toFixed(1) + '%', cls: cls };
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return '-';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }

  function fmtAgeLong(days) {
    if (days === null || days === undefined) return 'Listing date unknown';
    if (days >= 365) {
      return days.toLocaleString('en-US') + 'd (' + (days / 365).toFixed(1) + ' yrs)';
    }
    return days.toLocaleString('en-US') + ' days';
  }

  function parseHash() {
    var raw = window.location.hash ? window.location.hash.slice(1) : '';
    var params = new URLSearchParams(raw);
    state.q = params.get('q') || '';
    state.cat = params.get('cat') || '';
    state.chain = params.get('chain') || '';
    state.watch = params.get('watch') === '1';
    var sort = params.get('sort') || 'rank';
    var allowedSorts = ['rank', 'implied', 'tvl', 'change', 'age'];
    state.sort = allowedSorts.indexOf(sort) >= 0 ? sort : 'rank';
    var dir = params.get('dir');
    if (dir === 'asc' || dir === 'desc') {
      state.dir = dir;
    } else {
      state.dir = state.sort === 'rank' ? 'asc' : 'desc';
    }
    state.p = params.get('p') || '';
  }

  function buildHash(overrides) {
    var next = {
      q: state.q,
      cat: state.cat,
      chain: state.chain,
      watch: state.watch,
      sort: state.sort,
      dir: state.dir,
      p: state.p
    };
    if (overrides) {
      var keys = Object.keys(overrides);
      for (var k = 0; k < keys.length; k++) {
        next[keys[k]] = overrides[keys[k]];
      }
    }
    var params = new URLSearchParams();
    if (next.p) params.set('p', next.p);
    if (next.q) params.set('q', next.q);
    if (next.cat) params.set('cat', next.cat);
    if (next.chain) params.set('chain', next.chain);
    if (next.watch) params.set('watch', '1');
    if (next.sort !== 'rank') {
      params.set('sort', next.sort);
      params.set('dir', next.dir);
    } else if (next.dir !== 'asc') {
      params.set('sort', 'rank');
      params.set('dir', next.dir);
    }
    var s = params.toString();
    return s ? '#' + s : '';
  }

  function setHash(overrides) {
    var target = buildHash(overrides);
    if (target !== window.location.hash) {
      if (target) {
        window.location.hash = target;
      } else {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        parseHash();
        render();
      }
    }
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat) {
        var catName = r.category || 'Uncategorized';
        if (catName !== state.cat) return false;
      }
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q) {
        var inName = r.name.toLowerCase().indexOf(q) !== -1;
        var inSlug = r.slug.toLowerCase().indexOf(q) !== -1;
        if (!inName && !inSlug) return false;
      }
      return true;
    });

    var mul = state.dir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      var av, bv;
      if (state.sort === 'rank') {
        av = a.rank;
        bv = b.rank;
      } else if (state.sort === 'implied') {
        av = a.implied_value_usd;
        bv = b.implied_value_usd;
      } else if (state.sort === 'tvl') {
        av = a.tvl_usd;
        bv = b.tvl_usd;
      } else if (state.sort === 'change') {
        av = a.change_7d;
        bv = b.change_7d;
      } else if (state.sort === 'age') {
        av = a.age_days;
        bv = b.age_days;
      } else {
        av = a.rank;
        bv = b.rank;
      }
      // Unknown (null) metrics carry no signal, so they always sort last in
      // both directions; the direction multiplier must never promote them.
      var aNull = av === null || av === undefined;
      var bNull = bv === null || bv === undefined;
      if (aNull && bNull) return a.rank - b.rank;
      if (aNull) return 1;
      if (bNull) return -1;
      if (av !== bv) return (av - bv) * mul;
      return a.rank - b.rank;
    });
    return out;
  }

  function renderHeader() {
    return (
      '<header class="radar-header">' +
        '<div class="brand-row">' +
          '<div class="brand">' +
            '<div class="radar-emblem" aria-hidden="true"></div>' +
            '<div>' +
              '<h1>Token Launch Radar</h1>' +
              '<p>Deterministic implied-value ranking and farm playbooks for pre-token DeFi protocols.</p>' +
            '</div>' +
          '</div>' +
          '<span class="offline-pill">Offline Snapshot · ' + esc(meta.as_of) + '</span>' +
        '</div>' +
        '<div class="stat-grid">' +
          '<div class="stat-chip">' +
            '<div class="label">Protocols Scanned</div>' +
            '<div class="value">' + meta.scanned.toLocaleString('en-US') + '</div>' +
          '</div>' +
          '<div class="stat-chip accent-green">' +
            '<div class="label">Pre-Token Ranked</div>' +
            '<div class="value">' + meta.pre_token.toLocaleString('en-US') + '</div>' +
          '</div>' +
          '<div class="stat-chip accent-amber">' +
            '<div class="label">Watchlist Covered</div>' +
            '<div class="value">' + meta.watchlist_count.toLocaleString('en-US') + '</div>' +
          '</div>' +
          '<div class="stat-chip">' +
            '<div class="label">Combined Implied Value</div>' +
            '<div class="value">' + fmtUsd(totalImplied) + '</div>' +
          '</div>' +
          '<div class="stat-chip">' +
            '<div class="label">Snapshot Date</div>' +
            '<div class="value">' + esc(meta.as_of) + '</div>' +
          '</div>' +
        '</div>' +
      '</header>'
    );
  }

  function renderMethodology() {
    return (
      '<section class="methodology" aria-label="Model methodology">' +
        '<h2>Model Methodology</h2>' +
        '<p style="margin:0;color:var(--text-dim);font-size:13.5px;">' +
          'Every pre-token protocol (no CoinGecko id and no token symbol) in the sealed snapshot is scored strictly from its own snapshot figures — never from a hardcoded list of protocol names.' +
        '</p>' +
        '<div class="formula-box">' +
          'implied_value_usd = max(10,000, round(tvl_usd &times; category_multiple &times; momentum &times; maturity &times; breadth &times; eligibility))' +
        '</div>' +
        '<div class="method-grid">' +
          '<div class="method-card">' +
            '<h4>1. Category Multiple (0.15&times;&ndash;2.20&times;)</h4>' +
            '<p>Sector FDV/TVL prior reflecting fee velocity and token value capture: Dexs (2.2&times;) and Derivatives (2.0&times;) score highest; Lending (1.5&times;) and Risk Curators (1.3&times;) sit mid-high; passive Bridges (0.45&times;), Liquid Staking (0.45&times;), and CEX custody (0.15&times;) are discounted.</p>' +
          '</div>' +
          '<div class="method-card">' +
            '<h4>2. Momentum (0.76&times;&ndash;1.72&times;)</h4>' +
            '<p>Computed as 1 + clamp(change_7d, -40%, +120%) / 100 &times; 0.6. Rewards accelerating TVL inflows while capping extreme 7-day spikes; protocols with no 7d figure default to 1.00&times;.</p>' +
          '</div>' +
          '<div class="method-card">' +
            '<h4>3. Maturity (0.80&times;&ndash;1.25&times;)</h4>' +
            '<p>Computed as 0.80 + 0.45 &times; min(age_days, 1460) / 1460 from listed_at to snapshot as_of (' + esc(meta.as_of) + '). Rewards battle-tested protocols running without a token; unknown listing dates default to 1.00&times;.</p>' +
          '</div>' +
          '<div class="method-card">' +
            '<h4>4. Chain Breadth (1.00&times;&ndash;1.20&times;)</h4>' +
            '<p>Computed as 1 + 0.04 &times; min(chains - 1, 5). Adds a modest multi-chain distribution premium up to 6 active chains. Ties break by slug ascending, with values enforced strictly decreasing down the board.</p>' +
          '</div>' +
          '<div class="method-card">' +
            '<h4>5. Launch Eligibility (0.04&times; / 1.00&times;)</h4>' +
            '<p>Real pre-token launch candidates receive 1.00&times;. Established wrapped, staked, bridged, versioned, and exchange products that track already-trading tokens receive 0.04&times; so they never outrank real launches.</p>' +
          '</div>' +
        '</div>' +
        '<p class="method-eligibility">' +
          '<strong>Launch-eligibility screen:</strong> Mirrors the snapshot watchlist\'s own definition. A protocol is tagged <em>Established</em> (0.04&times; eligibility) when its category is Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, or CEX; its name contains the whole word wrapped, staked, or staking; its name begins with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, or Gemini; or its name ends in a version suffix (such as V2 or 2.0). All other pre-token protocols are scored at 1.00&times;.' +
        '</p>' +
        '<p class="method-disclaimer">' +
          'Note: Implied values are deterministic ranking estimates derived exclusively from snapshot TVL, category, 7-day change, listing age, and chain count. They are not token launch price predictions, valuation guarantees, or financial advice.' +
        '</p>' +
      '</section>'
    );
  }

  function renderChainsCell(list) {
    var shown = list.slice(0, 2);
    var html = '<div class="chain-list">';
    for (var i = 0; i < shown.length; i++) {
      html += '<span class="chain-tag">' + esc(shown[i]) + '</span>';
    }
    if (list.length > 2) {
      html += '<span class="chain-more">+' + (list.length - 2) + '</span>';
    }
    html += '</div>';
    return html;
  }

  function sortHeader(key, label, isNum) {
    var active = state.sort === key;
    var arrow = active ? (state.dir === 'asc' ? '&#9650;' : '&#9660;') : '';
    return (
      '<th class="sortable' + (isNum ? ' num' : '') + (active ? ' sorted' : '') + '" data-sort="' + key + '">' +
        esc(label) +
        (arrow ? '<span class="sort-arrow">' + arrow + '</span>' : '') +
      '</th>'
    );
  }

  function renderBoard() {
    var list = filteredRows();
    var filteredSum = list.reduce(function (acc, r) {
      return acc + r.implied_value_usd;
    }, 0);
    var hasFilter = Boolean(state.q || state.cat || state.chain || state.watch);

    var catOptions = '<option value="">All categories (' + categories.length + ')</option>';
    for (var i = 0; i < categories.length; i++) {
      var cName = categories[i][0];
      var cCount = categories[i][1];
      catOptions += '<option value="' + esc(cName) + '"' + (state.cat === cName ? ' selected' : '') + '>' + esc(cName) + ' (' + cCount + ')</option>';
    }

    var chainOptions = '<option value="">All chains (' + chains.length + ')</option>';
    for (var j = 0; j < chains.length; j++) {
      var chName = chains[j][0];
      var chCount = chains[j][1];
      chainOptions += '<option value="' + esc(chName) + '"' + (state.chain === chName ? ' selected' : '') + '>' + esc(chName) + ' (' + chCount + ')</option>';
    }

    var tbody = '';
    if (list.length === 0) {
      tbody = '<tr><td colspan="9" class="empty-state">No pre-token protocols match the current filters.</td></tr>';
    } else {
      for (var k = 0; k < list.length; k++) {
        var r = list[k];
        var chg = fmtChange(r.change_7d);
        tbody +=
          '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
            '<td class="rank-cell' + (r.rank <= 10 ? ' rank-top' : '') + '">#' + r.rank + '</td>' +
            '<td><div class="proto-name-line"><span class="proto-name">' + esc(r.name) + '</span>' + (r.established ? '<span class="est-tag">Established</span>' : '') + '</div><div class="proto-slug">' + esc(r.slug) + '</div></td>' +
            '<td><span class="cat-pill">' + esc(r.category || 'Uncategorized') + '</span></td>' +
            '<td>' + renderChainsCell(r.chains) + '</td>' +
            '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
            '<td class="num ' + chg.cls + '">' + chg.text + '</td>' +
            '<td class="num">' + fmtAge(r.age_days) + '</td>' +
            '<td class="num implied-val">' + fmtUsd(r.implied_value_usd) + '</td>' +
            '<td class="watch-cell">' + (r.watchlist ? '<span class="watch-badge">Watch</span>' : '<span class="watch-none">&mdash;</span>') + '</td>' +
          '</tr>';
      }
    }

    root.innerHTML =
      renderHeader() +
      '<section class="controls-panel" aria-label="Filter controls">' +
        '<input id="q-input" class="control-input" type="search" placeholder="Search protocol name or slug..." value="' + esc(state.q) + '" aria-label="Search protocol name or slug">' +
        '<select id="cat-select" class="control-select" aria-label="Filter by category">' + catOptions + '</select>' +
        '<select id="chain-select" class="control-select" aria-label="Filter by chain">' + chainOptions + '</select>' +
        '<button id="watch-btn" type="button" class="toggle-btn' + (state.watch ? ' active' : '') + '" aria-pressed="' + (state.watch ? 'true' : 'false') + '">' +
          '<span class="toggle-dot"></span>Watchlist only' +
        '</button>' +
        (hasFilter ? '<button id="reset-btn" type="button" class="reset-btn">Reset</button>' : '') +
        '<div class="results-meta">Showing <strong>' + list.length + '</strong> of ' + rows.length + ' &middot; ' + fmtUsd(filteredSum) + ' implied</div>' +
      '</section>' +
      '<div class="table-wrap">' +
        '<table class="radar-table">' +
          '<thead><tr>' +
            sortHeader('rank', 'Rank', false) +
            '<th>Protocol</th>' +
            '<th>Category</th>' +
            '<th>Chains</th>' +
            sortHeader('tvl', 'TVL', true) +
            sortHeader('change', '7d Change', true) +
            sortHeader('age', 'Age', true) +
            sortHeader('implied', 'Implied Value', true) +
            '<th style="text-align:center;">Watchlist</th>' +
          '</tr></thead>' +
          '<tbody>' + tbody + '</tbody>' +
        '</table>' +
      '</div>' +
      renderMethodology();

    bindBoardEvents();
  }

  function bindBoardEvents() {
    var qInput = document.getElementById('q-input');
    if (qInput) {
      qInput.addEventListener('input', function () {
        state.q = qInput.value;
        var hash = buildHash({ p: '' });
        history.replaceState(null, '', hash || (window.location.pathname + window.location.search));
        var pos = qInput.selectionStart;
        renderBoard();
        var nextInput = document.getElementById('q-input');
        if (nextInput) {
          nextInput.focus();
          if (typeof pos === 'number') nextInput.setSelectionRange(pos, pos);
        }
      });
    }

    var catSel = document.getElementById('cat-select');
    if (catSel) {
      catSel.addEventListener('change', function () {
        setHash({ cat: catSel.value, p: '' });
      });
    }

    var chainSel = document.getElementById('chain-select');
    if (chainSel) {
      chainSel.addEventListener('change', function () {
        setHash({ chain: chainSel.value, p: '' });
      });
    }

    var watchBtn = document.getElementById('watch-btn');
    if (watchBtn) {
      watchBtn.addEventListener('click', function () {
        setHash({ watch: !state.watch, p: '' });
      });
    }

    var resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        setHash({ q: '', cat: '', chain: '', watch: false, p: '' });
      });
    }

    var sortHeaders = root.querySelectorAll('th[data-sort]');
    for (var i = 0; i < sortHeaders.length; i++) {
      sortHeaders[i].addEventListener('click', function (ev) {
        var key = ev.currentTarget.getAttribute('data-sort');
        if (!key) return;
        var nextDir;
        if (state.sort === key) {
          nextDir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          nextDir = key === 'rank' ? 'asc' : 'desc';
        }
        setHash({ sort: key, dir: nextDir, p: '' });
      });
    }

    var trs = root.querySelectorAll('tbody tr[data-slug]');
    for (var j = 0; j < trs.length; j++) {
      trs[j].addEventListener('click', function (ev) {
        var slug = ev.currentTarget.getAttribute('data-slug');
        if (slug) setHash({ p: slug });
      });
      trs[j].addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          var slug = ev.currentTarget.getAttribute('data-slug');
          if (slug) setHash({ p: slug });
        }
      });
    }
  }

  function buildRankSentence(r) {
    var f = r.factors;
    var eff = r.tvl_usd > 0 ? r.implied_value_usd / r.tvl_usd : 0;
    if (r.established) {
      return (
        r.name + ' ranks #' + r.rank + ' of ' + meta.pre_token + ' at ' + fmtUsd(r.implied_value_usd) +
        ' implied value (' + eff.toFixed(2) + 'x on ' + fmtUsd(r.tvl_usd) + ' TVL) because it is flagged as an established product (' +
        f.eligibility.toFixed(2) + 'x launch eligibility) tracking an existing token rather than an upcoming launch.'
      );
    }
    var items = [
      { key: 'category multiple (' + f.category_multiple.toFixed(2) + 'x for ' + (r.category || 'Uncategorized') + ')', val: f.category_multiple },
      { key: '7-day momentum (' + f.momentum.toFixed(2) + 'x)', val: f.momentum },
      { key: 'maturity (' + f.maturity.toFixed(2) + 'x over ' + fmtAgeLong(r.age_days) + ')', val: f.maturity },
      { key: 'chain breadth (' + f.breadth.toFixed(2) + 'x across ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')', val: f.breadth }
    ];
    var strongest = items.slice().sort(function (a, b) { return b.val - a.val; })[0];
    var weakest = items.slice().sort(function (a, b) { return a.val - b.val; })[0];

    var tail = weakest.val < 0.99
      ? ', partially tempered by its ' + weakest.key
      : ', with no negative factor drags';

    return (
      r.name + ' ranks #' + r.rank + ' of ' + meta.pre_token + ' at ' + fmtUsd(r.implied_value_usd) +
      ' implied value (' + eff.toFixed(2) + 'x on ' + fmtUsd(r.tvl_usd) + ' TVL), passing the 1.00x launch-eligibility screen and led by its ' +
      strongest.key + tail + '.'
    );
  }

  function renderFactorBar(label, value, maxScale, note) {
    var pct = Math.max(4, Math.min(100, (value / maxScale) * 100));
    var basePct = (1.0 / maxScale) * 100;
    var status = value > 1.005 ? 'above' : value < 0.995 ? 'below' : 'neutral';
    return (
      '<div class="factor-row">' +
        '<div class="factor-head">' +
          '<span class="factor-name">' + esc(label) + '</span>' +
          '<span class="factor-val ' + status + '">' + value.toFixed(2) + '&times;</span>' +
        '</div>' +
        '<div class="factor-track">' +
          '<div class="factor-fill' + (status === 'below' ? ' below' : '') + '" style="width:' + pct.toFixed(1) + '%;"></div>' +
          '<div class="factor-baseline" style="left:' + basePct.toFixed(1) + '%;" title="1.00x baseline"></div>' +
        '</div>' +
        '<div class="factor-note">' + esc(note) + '</div>' +
      '</div>'
    );
  }

  function renderDetail(slug) {
    var r = bySlug.get(slug);
    var backHash = buildHash({ p: '' }) || '#';

    if (!r) {
      root.innerHTML =
        renderHeader() +
        '<div class="detail-top"><a class="back-btn" href="' + esc(backHash) + '">&larr; Back to radar board</a></div>' +
        '<div class="empty-state">Protocol "' + esc(slug) + '" was not found on the pre-token board.</div>';
      return;
    }

    var chg = fmtChange(r.change_7d);
    var effMult = r.tvl_usd > 0 ? r.implied_value_usd / r.tvl_usd : 0;
    var f = r.factors;

    var maxShownChains = 12;
    var chainChips = '';
    for (var i = 0; i < Math.min(r.chains.length, maxShownChains); i++) {
      chainChips += '<span class="chain-tag">' + esc(r.chains[i]) + '</span>';
    }
    if (r.chains.length > maxShownChains) {
      chainChips += '<span class="chain-more">+' + (r.chains.length - maxShownChains) + ' more</span>';
    }

    var stepsHtml = '';
    for (var s = 0; s < r.farm_steps.length; s++) {
      stepsHtml +=
        '<li class="farm-item">' +
          '<span class="farm-num">' + (s + 1) + '</span>' +
          '<div class="farm-text">' + esc(r.farm_steps[s]) + '</div>' +
        '</li>';
    }

    var chgNote = r.change_7d === null
      ? 'No 7-day TVL delta reported in snapshot (neutral 1.00x).'
      : '7-day TVL change of ' + chg.text + ', clamped to [-40%, +120%] at 0.6x weight.';
    var ageNote = r.age_days === null
      ? 'Listing date absent in snapshot (neutral 1.00x).'
      : fmtAgeLong(r.age_days) + ' live without a token as of ' + meta.as_of + ' (caps at 4 years).';
    var breadthNote = r.chains.length + ' active chain' + (r.chains.length === 1 ? '' : 's') +
      ' (+4% per additional chain, capped at +20% for 6+ chains).';
    var eligNote = r.established
      ? 'Established wrapped, staked, bridged, versioned, or exchange product tracking an existing token — no new token launch to farm.'
      : 'Passes the launch-eligibility screen (mirrors the watchlist rules) as a genuine pre-token launch candidate.';

    root.innerHTML =
      renderHeader() +
      '<div class="detail-top">' +
        '<a class="back-btn" id="back-link" href="' + esc(backHash) + '">&larr; Back to radar board</a>' +
        '<span class="results-meta">Rank <strong>#' + r.rank + '</strong> of ' + meta.pre_token + '</span>' +
      '</div>' +
      '<section class="detail-hero">' +
        '<div class="detail-title-row">' +
          '<span class="detail-rank">#' + r.rank + '</span>' +
          '<h2>' + esc(r.name) + '</h2>' +
          '<span class="detail-slug">' + esc(r.slug) + '</span>' +
          '<span class="cat-pill">' + esc(r.category || 'Uncategorized') + '</span>' +
          (r.watchlist ? '<span class="watch-badge">Watchlist</span>' : '') +
          (r.established ? '<span class="est-tag">Established</span>' : '') +
        '</div>' +
        '<p class="detail-rationale">' + esc(buildRankSentence(r)) + '</p>' +
        '<div class="metric-strip">' +
          '<div class="metric-box"><div class="k">Implied Value</div><div class="v" style="color:var(--green);" title="' + esc(fmtWholeUsd(r.implied_value_usd)) + '">' + fmtUsd(r.implied_value_usd) + '</div></div>' +
          '<div class="metric-box"><div class="k">Snapshot TVL</div><div class="v" title="' + esc(fmtWholeUsd(r.tvl_usd)) + '">' + fmtUsd(r.tvl_usd) + '</div></div>' +
          '<div class="metric-box"><div class="k">Effective Multiple</div><div class="v">' + effMult.toFixed(2) + '&times;</div></div>' +
          '<div class="metric-box"><div class="k">7d TVL Change</div><div class="v ' + chg.cls + '">' + chg.text + '</div></div>' +
          '<div class="metric-box"><div class="k">Protocol Age</div><div class="v">' + fmtAge(r.age_days) + '</div></div>' +
        '</div>' +
        '<div class="detail-chains"><span class="k">Active Chains (' + r.chains.length + '):</span>' + chainChips + '</div>' +
      '</section>' +
      '<div class="detail-grid">' +
        '<section class="panel">' +
          '<h3>Implied-Value Factor Breakdown</h3>' +
          '<div class="factor-list">' +
            renderFactorBar('Category Multiple', f.category_multiple, 2.4, 'FDV/TVL sector prior for ' + (r.category || 'Uncategorized') + ' (baseline 1.00x).') +
            renderFactorBar('7-Day Momentum', f.momentum, 1.8, chgNote) +
            renderFactorBar('Protocol Maturity', f.maturity, 1.4, ageNote) +
            renderFactorBar('Chain Breadth', f.breadth, 1.4, breadthNote) +
            renderFactorBar('Launch Eligibility', f.eligibility, 1.2, eligNote) +
          '</div>' +
        '</section>' +
        '<section class="panel">' +
          '<h3>Concrete 6-Step Farm Plan</h3>' +
          '<ol class="farm-list">' + stepsHtml + '</ol>' +
        '</section>' +
      '</div>' +
      renderMethodology();

    var backLink = document.getElementById('back-link');
    if (backLink) {
      backLink.addEventListener('click', function (ev) {
        ev.preventDefault();
        setHash({ p: '' });
      });
    }
  }

  function render() {
    if (state.p) {
      renderDetail(state.p);
    } else {
      renderBoard();
    }
  }

  window.addEventListener('hashchange', function () {
    parseHash();
    render();
  });

  parseHash();
  render();
})();
