/* Token Launch Radar - dashboard logic.
   Renders entirely from window.RADAR (the data.js payload the program
   writes beside this page). No network, no storage: view state lives in
   the URL hash so any filtered view or detail page can be linked or
   screenshotted by URL. */

(function () {
  "use strict";

  var data = window.RADAR || { meta: {}, rows: [] };
  var rows = data.rows || [];
  var meta = data.meta || {};
  var board = document.getElementById("board");

  /* ---------------- formatting ---------------- */

  function esc(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function commas(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function fmtUsdFull(n) {
    return "$" + commas(n);
  }

  function fmtUsd(n) {
    if (n >= 1e9) return "$" + trimNum(n / 1e9) + "B";
    if (n >= 1e6) return "$" + trimNum(n / 1e6) + "M";
    if (n >= 1e3) return "$" + trimNum(n / 1e3) + "K";
    return "$" + commas(n);
  }

  function trimNum(x) {
    var r = Math.round(x * 100) / 100;
    return Number.isInteger(r) ? String(r) : String(r);
  }

  function fmtPct(v) {
    if (v === null || v === undefined) return null;
    var r = Math.round(v * 10) / 10;
    return (r > 0 ? "+" : "") + (Number.isInteger(r) ? String(r) : r.toFixed(1)) + "%";
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return null;
    if (days < 60) return days + "d";
    if (days < 730) return Math.round(days / 30.44) + "mo";
    var years = Math.round((days / 365.25) * 10) / 10;
    return (Number.isInteger(years) ? String(years) : years.toFixed(1)) + "y";
  }

  function fmtFactor(v) {
    return (Math.round(v * 100) / 100).toFixed(2) + "x";
  }

  /* ---------------- hash state ----------------
     #q= text search, #cat= category, #chain= chain, #watch=1 watchlist
     only, #sort= rank|value|tvl|change|age, #dir= asc|desc, #p= detail */

  function parseHash() {
    var state = {
      q: "",
      cat: "",
      chain: "",
      watch: false,
      sort: "rank",
      dir: "asc",
      p: "",
    };
    var raw = window.location.hash.replace(/^#/, "");
    if (!raw) return state;
    raw.split("&").forEach(function (pair) {
      if (!pair) return;
      var idx = pair.indexOf("=");
      var key = idx === -1 ? pair : pair.slice(0, idx);
      var value = idx === -1 ? "" : decodeURIComponent(pair.slice(idx + 1));
      if (key === "q") state.q = value;
      else if (key === "cat") state.cat = value;
      else if (key === "chain") state.chain = value;
      else if (key === "watch") state.watch = value === "1";
      else if (key === "sort") state.sort = value;
      else if (key === "dir") state.dir = value === "desc" ? "desc" : "asc";
      else if (key === "p") state.p = value;
    });
    return state;
  }

  function buildHash(state) {
    var parts = [];
    if (state.p) parts.push("p=" + encodeURIComponent(state.p));
    if (state.q) parts.push("q=" + encodeURIComponent(state.q));
    if (state.cat) parts.push("cat=" + encodeURIComponent(state.cat));
    if (state.chain) parts.push("chain=" + encodeURIComponent(state.chain));
    if (state.watch) parts.push("watch=1");
    if (state.sort && state.sort !== "rank") parts.push("sort=" + state.sort);
    if (state.dir && state.dir !== "asc") parts.push("dir=" + state.dir);
    return parts.length ? "#" + parts.join("&") : "#";
  }

  function go(state) {
    var next = buildHash(state);
    if (window.location.hash === next || (next === "#" && !window.location.hash)) {
      render();
    } else {
      window.location.hash = next;
    }
  }

  /* ---------------- filtering and sorting ---------------- */

  function categories() {
    var counts = {};
    rows.forEach(function (r) {
      var c = r.category || "Uncategorised";
      counts[c] = (counts[c] || 0) + 1;
    });
    return Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : 1);
    }).map(function (c) {
      return { name: c, count: counts[c] };
    });
  }

  function chains() {
    var counts = {};
    rows.forEach(function (r) {
      r.chains.forEach(function (c) {
        counts[c] = (counts[c] || 0) + 1;
      });
    });
    return Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : 1);
    }).map(function (c) {
      return { name: c, count: counts[c] };
    });
  }

  function filtered(state) {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat && (r.category || "Uncategorised") !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q) {
        var hay = (r.name + " " + r.slug).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function sortKey(row, key) {
    if (key === "value") return row.implied_value_usd;
    if (key === "tvl") return row.tvl_usd;
    if (key === "change") return row.change_7d;
    if (key === "age") return row.age_days;
    return row.rank;
  }

  /* Unknown values (null change, null age) always sort last, whichever
     direction the reader picked - a missing figure is not a small one. */
  function sorted(list, state) {
    var mul = state.dir === "desc" ? -1 : 1;
    return list.slice().sort(function (a, b) {
      var av = sortKey(a, state.sort);
      var bv = sortKey(b, state.sort);
      var aNull = av === null || av === undefined;
      var bNull = bv === null || bv === undefined;
      if (aNull && bNull) return a.rank - b.rank;
      if (aNull) return 1;
      if (bNull) return -1;
      if (av !== bv) return (av - bv) * mul;
      return a.rank - b.rank;
    });
  }

  function combinedValue(list) {
    var total = 0;
    list.forEach(function (r) {
      total += r.implied_value_usd;
    });
    return total;
  }

  function bySlug(slug) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].slug === slug) return rows[i];
    }
    return null;
  }

  /* ---------------- shared fragments ---------------- */

  function headerHtml() {
    var total = combinedValue(rows);
    return (
      '<header class="radar-head">' +
      '<p class="radar-kicker">Token Launch Radar</p>' +
      "<h1 class=\"radar-title\">Which pre-token protocol is worth farming next?</h1>" +
      '<p class="radar-sub">A deterministic radar over a sealed snapshot of ' +
      esc(commas(meta.scanned || rows.length)) +
      " protocols. It ranks the " +
      esc(commas(meta.pre_token || rows.length)) +
      " that record no token yet by an implied launch value derived only from the snapshot's own figures - TVL, 7-day momentum, time running with no token, and chain breadth - screened for products that are really a wrapped or staked form of a token that already trades. Every row carries a concrete farm plan.</p>" +
      '<div class="chips">' +
      '<span class="chip"><strong>' + esc(commas(meta.scanned || 0)) + "</strong> scanned</span>" +
      '<span class="chip"><span class="accent">' + esc(commas(meta.pre_token || 0)) + "</span> pre-token ranked</span>" +
      '<span class="chip"><span class="amber">' + esc(commas(meta.watchlist_count || 0)) + "</span> watchlist covered</span>" +
      '<span class="chip"><strong>' + esc(fmtUsd(total)) + "</strong> combined implied value</span>" +
      '<span class="chip">snapshot <strong>' + esc(meta.as_of || "") + "</strong></span>" +
      "</div>" +
      "</header>"
    );
  }

  function methodologyHtml() {
    return (
      '<section class="methodology"><h3>Model methodology</h3>' +
      "<p><strong>The formula.</strong> implied value = TVL x <code>category multiple</code> x <code>momentum</code> x <code>maturity</code> x <code>breadth</code> x <code>eligibility</code>, floored at $10,000, in whole dollars, then nudged so ranks strictly decrease.</p>" +
      "<p><strong>Category multiple</strong> is a prior over sectors - what a launch in that category has historically been worth against the TVL already inside it. It is a table over categories, never over protocol names. <strong>Momentum</strong> scales with the 7-day TVL change, clamped so one hot week cannot dominate. <strong>Maturity</strong> rewards time running with no token, measured from the day DefiLlama began tracking the protocol to the snapshot date, capped at four years. <strong>Breadth</strong> adds a small premium per extra chain, up to five.</p>" +
      "<p><strong>Eligibility</strong> is the launch screen: a protocol that is a wrapped, staked or bridged product of a token that already trades - or a later version of one, or an exchange's own product - is not waiting on a launch of its own, so it is screened to 0.04x and its plan says there is no launch to farm. The snapshot's watchlist applies the same exclusions and is covered in full; it is a floor, never a ceiling.</p>" +
      "<p><strong>Honesty.</strong> The snapshot records whether a token is listed, never proof that none exists: read every row as \u201crecords no token\u201d. Implied values are this model's estimates for ranking, not prices, predictions or advice.</p>" +
      "</section>"
    );
  }

  function footerHtml() {
    return (
      '<p class="footer-note">Built from a sealed snapshot dated ' +
      esc(meta.as_of || "") +
      ". Re-running the program on the same snapshot reproduces this board byte for byte.</p>"
    );
  }

  function badgeHtml(row) {
    var out = "";
    if (row.watchlist) out += ' <span class="badge badge-watch">WATCH</span>';
    if (row.established) out += ' <span class="badge badge-established">ESTABLISHED</span>';
    return out;
  }

  function changeHtml(v) {
    var text = fmtPct(v);
    if (text === null) return '<span class="unknown">-</span>';
    var cls = v > 0 ? "pos" : v < 0 ? "neg" : "flat";
    return '<span class="' + cls + '">' + esc(text) + "</span>";
  }

  function ageHtml(days) {
    var text = fmtAge(days);
    return text === null ? '<span class="unknown">-</span>' : esc(text);
  }

  function chainsHtml(list) {
    if (list.length <= 3) return esc(list.join(", "));
    return esc(list.slice(0, 3).join(", ") + " +" + (list.length - 3));
  }

  /* ---------------- board view ---------------- */

  function controlsHtml(state) {
    var catOptions = ['<option value="">All categories</option>']
      .concat(
        categories().map(function (c) {
          var sel = state.cat === c.name ? " selected" : "";
          return '<option value="' + esc(c.name) + '"' + sel + ">" + esc(c.name) + " (" + c.count + ")</option>";
        }),
      )
      .join("");
    var chainOptions = ['<option value="">All chains</option>']
      .concat(
        chains().map(function (c) {
          var sel = state.chain === c.name ? " selected" : "";
          return '<option value="' + esc(c.name) + '"' + sel + ">" + esc(c.name) + " (" + c.count + ")</option>";
        }),
      )
      .join("");
    var dirty = state.q || state.cat || state.chain || state.watch;
    return (
      '<div class="controls">' +
      '<input type="search" id="q-input" placeholder="Search name or slug" value="' + esc(state.q) + '" aria-label="Search by name or slug">' +
      '<select id="cat-select" aria-label="Filter by category">' + catOptions + "</select>" +
      '<select id="chain-select" aria-label="Filter by chain">' + chainOptions + "</select>" +
      '<button type="button" class="toggle-btn" id="watch-btn" aria-pressed="' + (state.watch ? "true" : "false") + '">Watchlist only</button>' +
      (dirty ? '<button type="button" class="reset-btn" id="reset-btn">Reset</button>' : "") +
      "</div>"
    );
  }

  var SORTS = [
    { key: "rank", label: "Rank", num: false },
    { key: "value", label: "Implied value", num: true },
    { key: "tvl", label: "TVL", num: true },
    { key: "change", label: "7d change", num: true },
    { key: "age", label: "Age", num: true },
  ];

  function tableHtml(list, state) {
    if (!list.length) {
      return '<div class="board-wrap"><p class="empty-note">No protocols match this filter. Loosen the search or reset the controls.</p></div>';
    }
    var head = SORTS.map(function (s) {
      var sortedHere = state.sort === s.key;
      var arrow = sortedHere ? (state.dir === "asc" ? " \u25B2" : " \u25BC") : "";
      return (
        '<th class="' + (s.num ? "num" : "") + (sortedHere ? " sorted" : "") + '">' +
        '<button type="button" class="sort-btn" data-sort="' + s.key + '">' +
        esc(s.label) + '<span class="arrow">' + arrow + "</span></button></th>"
      );
    });
    var fixedHead =
      "<th>Protocol</th><th>Category</th><th>Chains</th>";
    var headRow =
      "<tr>" + head[0] + fixedHead + head[1] + head[2] + head[3] + head[4] + "<th></th></tr>";

    var body = list
      .map(function (r) {
        return (
          '<tr data-slug="' + esc(r.slug) + '">' +
          '<td class="rank">' + r.rank + "</td>" +
          '<td><span class="proto-name">' + esc(r.name) + '</span><span class="proto-slug">' + esc(r.slug) + "</span></td>" +
          '<td class="proto-cat">' + esc(r.category || "Uncategorised") + "</td>" +
          '<td class="proto-chains" title="' + esc(r.chains.join(", ")) + '">' + chainsHtml(r.chains) + "</td>" +
          '<td class="num value">' + esc(fmtUsd(r.implied_value_usd)) + "</td>" +
          '<td class="num tvl">' + esc(fmtUsd(r.tvl_usd)) + "</td>" +
          '<td class="num">' + changeHtml(r.change_7d) + "</td>" +
          '<td class="num">' + ageHtml(r.age_days) + "</td>" +
          "<td>" + badgeHtml(r) + "</td>" +
          "</tr>"
        );
      })
      .join("");

    return '<div class="board-wrap"><table class="board"><thead>' + headRow + "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function renderBoard(state) {
    var list = sorted(filtered(state), state);
    var total = combinedValue(list);
    board.innerHTML =
      headerHtml() +
      controlsHtml(state) +
      '<p class="results-line">Showing <strong>' + list.length + "</strong> of " + rows.length +
      " protocols \u00B7 <strong>" + esc(fmtUsd(total)) + "</strong> implied in view</p>" +
      tableHtml(list, state) +
      methodologyHtml() +
      footerHtml();
    wireBoard(state);
  }

  function wireBoard(state) {
    var q = document.getElementById("q-input");
    if (q) {
      q.addEventListener("change", function () {
        var next = parseHash();
        next.q = q.value;
        go(next);
      });
      q.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          var next = parseHash();
          next.q = q.value;
          go(next);
        }
      });
    }
    var cat = document.getElementById("cat-select");
    if (cat) {
      cat.addEventListener("change", function () {
        var next = parseHash();
        next.cat = cat.value;
        go(next);
      });
    }
    var chain = document.getElementById("chain-select");
    if (chain) {
      chain.addEventListener("change", function () {
        var next = parseHash();
        next.chain = chain.value;
        go(next);
      });
    }
    var watch = document.getElementById("watch-btn");
    if (watch) {
      watch.addEventListener("click", function () {
        var next = parseHash();
        next.watch = !next.watch;
        go(next);
      });
    }
    var reset = document.getElementById("reset-btn");
    if (reset) {
      reset.addEventListener("click", function () {
        go({ q: "", cat: "", chain: "", watch: false, sort: "rank", dir: "asc", p: "" });
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-sort]"), function (btn) {
      btn.addEventListener("click", function () {
        var next = parseHash();
        var key = btn.getAttribute("data-sort");
        if (next.sort === key) {
          next.dir = next.dir === "asc" ? "desc" : "asc";
        } else {
          next.sort = key;
          next.dir = key === "rank" ? "asc" : "desc";
        }
        go(next);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("tr[data-slug]"), function (tr) {
      tr.addEventListener("click", function () {
        var next = parseHash();
        next.p = tr.getAttribute("data-slug");
        go(next);
      });
    });
  }

  /* ---------------- detail view ---------------- */

  function factorBar(label, value) {
    var scale = 2.6;
    var pct = Math.max(0, Math.min(100, (value / scale) * 100));
    var base = (1 / scale) * 100;
    var cls = value < 1 ? "factor-fill low" : "factor-fill";
    return (
      '<div class="factor-row"><span class="f-label">' + esc(label) + "</span>" +
      '<span class="factor-track"><span class="' + cls + '" style="width:' + pct.toFixed(1) + '%"></span>' +
      '<span class="factor-base" style="left:' + base.toFixed(1) + '%"></span></span>' +
      '<span class="f-value">' + esc(fmtFactor(value)) + "</span></div>"
    );
  }

  function rankSentence(row) {
    var f = row.factors;
    var sentence =
      "Ranks #" + row.rank + " because " + fmtUsdFull(row.tvl_usd) + " of TVL at a " +
      fmtFactor(f.category_multiple) + " " + (row.category || "default") +
      " multiple, adjusted by momentum " + fmtFactor(f.momentum) +
      ", maturity " + fmtFactor(f.maturity) + " and breadth " + fmtFactor(f.breadth);
    if (row.established) {
      sentence +=
        ", then screened to " + fmtFactor(f.eligibility) +
        " eligibility as an established product,";
    }
    sentence += " implies " + fmtUsdFull(row.implied_value_usd) + ".";
    return sentence;
  }

  function renderDetail(state, row) {
    var f = row.factors;
    var backState = {
      q: state.q, cat: state.cat, chain: state.chain,
      watch: state.watch, sort: state.sort, dir: state.dir, p: "",
    };
    var cards =
      '<div class="metric-cards">' +
      '<div class="metric-card"><p class="m-label">Implied value</p><p class="m-value green">' + esc(fmtUsd(row.implied_value_usd)) + "</p></div>" +
      '<div class="metric-card"><p class="m-label">TVL</p><p class="m-value">' + esc(fmtUsd(row.tvl_usd)) + "</p></div>" +
      '<div class="metric-card"><p class="m-label">Category multiple</p><p class="m-value">' + esc(fmtFactor(f.category_multiple)) + "</p></div>" +
      '<div class="metric-card"><p class="m-label">7d change</p><p class="m-value">' + changeHtml(row.change_7d) + "</p></div>" +
      '<div class="metric-card"><p class="m-label">Age</p><p class="m-value">' + ageHtml(row.age_days) + "</p></div>" +
      "</div>";

    var tags = row.chains
      .map(function (c) {
        return '<span class="chain-tag">' + esc(c) + "</span>";
      })
      .join("");

    var steps = row.farm_steps
      .map(function (s) {
        return "<li>" + esc(s) + "</li>";
      })
      .join("");

    board.innerHTML =
      '<a class="back-link" href="' + buildHash(backState) + '">\u2190 Back to the board</a>' +
      '<section class="detail-hero">' +
      '<p class="radar-kicker">Rank #' + row.rank + "</p>" +
      "<h2>" + esc(row.name) + badgeHtml(row) + "</h2>" +
      '<p class="slug-line">' + esc(row.slug) + " \u00B7 " + esc(row.category || "Uncategorised") + "</p>" +
      '<p class="rank-sentence">' + esc(rankSentence(row)) + "</p>" +
      '<div class="chain-tags">' + tags + "</div>" +
      "</section>" +
      cards +
      '<section class="panel"><h3>Model factors</h3>' +
      factorBar("Category multiple", f.category_multiple) +
      factorBar("Momentum (7d TVL)", f.momentum) +
      factorBar("Maturity (time pre-token)", f.maturity) +
      factorBar("Breadth (chains)", f.breadth) +
      factorBar("Eligibility (launch screen)", f.eligibility) +
      '<p class="factor-note">Bars run 0 to 2.60x; the tick marks the 1.00x baseline. Eligibility is 1.00x for launch candidates and 0.04x for established products.</p>' +
      "</section>" +
      '<section class="panel"><h3>Farm plan</h3><ol class="farm-list">' + steps + "</ol></section>" +
      methodologyHtml() +
      footerHtml();
  }

  /* ---------------- dispatch ---------------- */

  function render() {
    var state = parseHash();
    if (state.p) {
      var row = bySlug(state.p);
      if (row) {
        renderDetail(state, row);
        return;
      }
    }
    renderBoard(state);
  }

  window.addEventListener("hashchange", render);
  render();
})();
