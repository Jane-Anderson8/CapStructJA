/*
 * app.js — reads the CSV files in data/, runs the math in capstruct.js and
 * fills in the page. All of the finance lives in capstruct.js.
 */
(function () {
  'use strict';
  var C = window.CapStruct;
  var r = C.roundHalfUp;

  // ---------- Formatting (round half up on the decimal value) ----------

  function withCommas(x, d) {
    return r(x, d).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // Dollars to the nearest dollar; negatives (costs) in parentheses like the case.
  function dollars(x) {
    if (x === null || x === undefined) return 'n/a';
    var s = '$' + withCommas(Math.abs(x), 0);
    return r(x, 0) < 0 ? '(' + s + ')' : s;
  }
  function cost(x) { return '(' + withCommas(x, 0) + ')'; }
  function cents(x) { return (x === null || x === undefined) ? 'n/a' : '$' + withCommas(x, 2); }
  function pct(x) { return (x === null || x === undefined) ? 'n/a' : withCommas(x * 100, 2) + '%'; }
  function times(x) { return (x === null || x === undefined) ? 'n/a' : withCommas(x, 2) + '×'; }
  function count(x) { return (x === null || x === undefined) ? 'n/a' : withCommas(x, 2); }
  function plain(x, d) { return (x === null || x === undefined) ? 'n/a' : withCommas(x, d); }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- Loading ----------

  function load(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('Could not read ' + path + ' (' + res.status + ').');
      return res.text();
    }).then(C.parseCSV);
  }

  Promise.all([
    load('data/cdss.csv'),
    load('data/assumptions.csv'),
    load('data/banker_schedule.csv'),
    load('data/example_firms.csv'),
    load('data/ebit_scenarios.csv')
  ]).then(function (files) {
    var cdss = C.readCDSS(files[0]);
    var T = C.readAssumptions(files[1]).taxRate;
    var schedule = C.readSchedule(files[2], 'data/banker_schedule.csv');
    var ex = C.readExampleFirms(files[3]);
    var scenarios = C.readScenarios(files[4]);

    renderInputs(cdss, T);
    setupFirmLever(ex, scenarios, T);
    var res = C.analyzeCDSS(cdss, schedule, T);
    renderCDSS(res, cdss);
    setupCDSSLever(res, cdss);
    document.getElementById('status').hidden = true;
  }).catch(function (err) {
    var s = document.getElementById('status');
    s.classList.add('error');
    s.textContent = 'The app could not load its data: ' + err.message +
      ' (If you opened index.html straight from your computer, the browser blocks reading data/. Use the published GitHub Pages address.)';
  });

  // ---------- Inputs ----------

  function renderInputs(c, T) {
    var list = document.getElementById('input-list');
    var items = [
      ['Sales', dollars(c.sales)],
      ['Variable cost rate', pct(c.variableCostRate)],
      ['Fixed costs', dollars(c.fixedCosts)],
      ['EBIT', dollars(C.cdssEBIT(c))],
      ['Tax rate (T)', pct(T)],
      ['Shares outstanding (n)', plain(c.shares, 0)],
      ['Share price today (P₀)', cents(c.price)],
      ['Total book assets (A)', dollars(c.totalAssets)],
      ['Management\'s share', pct(c.managementShare)]
    ];
    items.forEach(function (it) {
      var d = el('div');
      d.appendChild(el('dt', null, it[0]));
      d.appendChild(el('dd', null, it[1]));
      list.appendChild(d);
    });
    document.getElementById('inputs').hidden = false;
  }

  // ---------- Firm U and Firm L ----------

  function firmTable(table, name, f, T) {
    table.innerHTML = '';
    table.appendChild(el('caption', null, name + (f.debt ? ' (' + dollars(f.debt) + ' of debt)' : ' (no debt)')));
    var head = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', { scope: 'col' }, ''));
    f.years.forEach(function (y) { hr.appendChild(el('th', { scope: 'col' }, 'p = ' + plain(y.probability, 2))); });
    head.appendChild(hr);
    table.appendChild(head);

    var body = el('tbody');
    function row(label, fn, cls) {
      var tr = el('tr', cls ? { 'class': cls } : null);
      tr.appendChild(el('th', { scope: 'row' }, label));
      f.years.forEach(function (y) { tr.appendChild(el('td', null, fn(y))); });
      body.appendChild(tr);
    }
    row('Assets', function () { return dollars(f.assets); });
    row('Equity', function () { return dollars(f.equity); });
    row('Sales', function (y) { return dollars(y.sales); });
    row('Oper. costs', function (y) { return cost(y.operatingCosts); });
    row('EBIT', function (y) { return dollars(y.ebit); }, 'subtotal');
    row('Interest', function (y) { return cost(y.interest); });
    row('EBT', function (y) { return dollars(y.ebt); }, 'subtotal');
    row('Taxes (' + plain(T * 100, 0) + '%)', function (y) { return cost(y.taxes); });
    row('Net income', function (y) { return dollars(y.netIncome); }, 'subtotal');
    row('ROE', function (y) { return pct(y.roe); });
    row('TIE', function (y) { return times(y.tie); });
    table.appendChild(body);
  }

  function renderFirms(firms, ex, T) {
    document.getElementById('firms-note').textContent =
      'Both firms have ' + dollars(ex.totalAssets) + ' of assets and a ' + pct(T) + ' tax rate. Firm L borrows ' +
      dollars(firms.L.debt) + ' at ' + pct(ex.interestRate) + '. ROE uses book equity (assets − debt). Firm U pays no interest, so its TIE is n/a.';
    firmTable(document.getElementById('firm-u'), 'Firm U', firms.U, T);
    firmTable(document.getElementById('firm-l'), 'Firm L', firms.L, T);

    var t = document.getElementById('firm-stats');
    t.innerHTML = '';
    var head = el('thead');
    var hr = el('tr');
    ['', 'Firm U', 'Firm L'].forEach(function (h) { hr.appendChild(el('th', { scope: 'col' }, h)); });
    head.appendChild(hr);
    t.appendChild(head);
    var body = el('tbody');
    [
      ['E(ROE)', pct(firms.U.eRoe), pct(firms.L.eRoe)],
      ['σ(ROE)', pct(firms.U.sdRoe), pct(firms.L.sdRoe)],
      ['CV of ROE (σ / E)', plain(firms.U.cvRoe, 2), plain(firms.L.cvRoe, 2)],
      ['E(TIE)', times(firms.U.eTie), times(firms.L.eTie)],
      ['σ(TIE)', times(firms.U.sdTie), times(firms.L.sdTie)]
    ].forEach(function (cells) {
      var tr = el('tr');
      tr.appendChild(el('th', { scope: 'row' }, cells[0]));
      tr.appendChild(el('td', null, cells[1]));
      tr.appendChild(el('td', null, cells[2]));
      body.appendChild(tr);
    });
    t.appendChild(body);
    document.getElementById('firms').hidden = false;
  }

  // Firm L slider: 0 to slider_max in steps of slider_step, rate held at 12%.
  function setupFirmLever(ex, scenarios, T) {
    var steps = C.firmLDebtSteps(ex);
    var slider = document.getElementById('firml-debt');
    var out = document.getElementById('firml-debt-out');
    slider.max = steps.length - 1;
    var caseIdx = steps.indexOf(ex.firmLDebt);
    document.getElementById('firml-rate-note').textContent =
      'Firm L\'s interest rate is held at ' + pct(ex.interestRate) + ' at every amount of debt, so the slider shows what debt does to ' +
      'Firm L\'s return and risk, not how lenders would respond. The Case button goes back to ' + dollars(ex.firmLDebt) + '.';
    function show(i) {
      slider.value = i;
      out.textContent = dollars(steps[i]);
      slider.setAttribute('aria-valuetext', dollars(steps[i]));
      renderFirms(C.exampleFirms(ex, scenarios, T, steps[i]), ex, T);
    }
    slider.addEventListener('input', function () { show(Number(slider.value)); });
    var btn = document.getElementById('btn-case');
    if (caseIdx < 0) {
      btn.disabled = true;
      btn.title = 'The case\'s ' + dollars(ex.firmLDebt) + ' is not one of the slider\'s steps.';
      show(0);
    } else {
      btn.addEventListener('click', function () { show(caseIdx); });
      show(caseIdx);
    }
  }

  // ---------- CDSS ----------

  // columns: [header, fn(row) -> text, bestKey or null]
  function cdssTable(table, rows, columns, best) {
    table.innerHTML = '';
    var head = el('thead');
    var hr = el('tr');
    columns.forEach(function (c) { hr.appendChild(el('th', { scope: 'col' }, c[0])); });
    head.appendChild(hr);
    table.appendChild(head);
    var body = el('tbody');
    rows.forEach(function (row, i) {
      var tr = el('tr');
      columns.forEach(function (c) {
        var attrs = { 'data-label': c[0] };
        if (c[2] && best[c[2]] === i) attrs['class'] = 'best';
        tr.appendChild(el('td', attrs, c[1](row)));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderCDSS(res, c) {
    // Warnings (for example if EPS / r_s at $0 does not equal today's price)
    var w = document.getElementById('warnings');
    w.innerHTML = '';
    res.warnings.forEach(function (msg) { w.appendChild(el('div', { 'class': 'warning', role: 'alert' }, msg)); });

    Array.prototype.forEach.call(document.querySelectorAll('.p0'), function (s) { s.textContent = plain(c.price, 2); });
    document.getElementById('cdss-note').textContent =
      'EBIT is ' + dollars(res.ebit) + ' at every amount of debt, because the case says it is constant. ' +
      'CDSS pays out all its earnings, so dividends per share = EPS and g = 0. ' +
      (res.zeroCheck.ok ? 'Check passed: at $0 of debt, EPS / r_s = ' + cents(res.zeroCheck.implied) + ', today\'s price. ' : '') +
      'Green cells mark the best amount in each column; the outlined row is the amount on the slider. Share counts are not rounded; they are shown to two decimals.';

    var rd = function (x) { return x.rd === null ? '—' : pct(x.rd); };

    cdssTable(document.getElementById('case-table'), res.rows, [
      ['Debt (D)', function (x) { return dollars(x.debt); }],
      ['r_d', rd],
      ['r_s', function (x) { return pct(x.rs); }],
      ['Interest', function (x) { return dollars(x.caseM.interest); }],
      ['Net income', function (x) { return dollars(x.caseM.netIncome); }],
      ['Shares repurchased', function (x) { return count(x.caseM.repurchased); }],
      ['Shares remaining', function (x) { return count(x.caseM.remaining); }],
      ['EPS', function (x) { return cents(x.caseM.eps); }, 'caseEps'],
      ['TIE', function (x) { return times(x.caseM.tie); }],
      ['Share price', function (x) { return cents(x.caseM.price); }, 'casePrice'],
      ['WACC (book weights)', function (x) { return pct(x.caseM.wacc); }, 'bookWacc']
    ], res.best);

    cdssTable(document.getElementById('new-table'), res.rows, [
      ['Debt (D)', function (x) { return dollars(x.debt); }],
      ['r_d', rd],
      ['r_s', function (x) { return pct(x.rs); }],
      ['Net income', function (x) { return dollars(x.newM.netIncome); }],
      ['Equity value (S)', function (x) { return dollars(x.newM.equityValue); }],
      ['Firm value (V)', function (x) { return dollars(x.newM.firmValue); }],
      ['Share price (P)', function (x) { return cents(x.newM.price); }, 'newPrice'],
      ['Shares repurchased', function (x) { return count(x.newM.repurchased); }],
      ['Shares remaining', function (x) { return count(x.newM.remaining); }],
      ['EPS', function (x) { return cents(x.newM.eps); }, 'newEps'],
      ['TIE', function (x) { return times(x.newM.tie); }],
      ['WACC (market weights)', function (x) { return pct(x.newM.wacc); }, 'marketWacc'],
      ['Checks', function (x) { return (x.newM.epsCheckOk && x.newM.waccCheckOk) ? '✓' : '✗ failed'; }]
    ], res.best);

    var list = document.getElementById('best-list');
    list.innerHTML = '';
    function at(i) { return i >= 0 ? dollars(res.rows[i].debt) : 'none'; }
    var b = res.best;
    [
      'Highest share price, case method ($' + plain(c.price, 2) + ' buyback): ' + at(b.casePrice) +
        (b.casePrice >= 0 ? ' (' + cents(res.rows[b.casePrice].caseM.price) + ')' : ''),
      'Highest share price, new-price method: ' + at(b.newPrice) +
        (b.newPrice >= 0 ? ' (' + cents(res.rows[b.newPrice].newM.price) + ')' : ''),
      'Lowest WACC, book weights: ' + at(b.bookWacc) +
        (b.bookWacc >= 0 ? ' (' + pct(res.rows[b.bookWacc].caseM.wacc) + ')' : ''),
      'Lowest WACC, market weights: ' + at(b.marketWacc) +
        (b.marketWacc >= 0 ? ' (' + pct(res.rows[b.marketWacc].newM.wacc) + ')' : ''),
      'Highest EPS: ' + at(b.caseEps) + ' (case method), ' + at(b.newEps) + ' (new-price method)'
    ].forEach(function (t) { list.appendChild(el('li', null, t)); });
    list.appendChild(el('li', { 'class': b.allAgree ? 'agree' : 'disagree' }, b.allAgree
      ? 'Both prices and both WACCs point to the same amount: ' + at(b.casePrice) + '.'
      : 'These measures do not all point to the same amount of debt, so the app does not pick one.'));

    document.getElementById('cdss').hidden = false;
  }

  // ---------- CDSS debt slider and buttons ----------

  function stakeText(m) {
    if (m.status === 'sell') return 'Management would have to sell';
    return pct(m.stake) + (m.status === 'all' ? ' *' : '');
  }

  function setupCDSSLever(res, c) {
    var rows = res.rows;
    var slider = document.getElementById('cdss-debt');
    var out = document.getElementById('cdss-debt-out');
    var note = document.getElementById('button-note');
    slider.max = rows.length - 1;

    function markRow(i) {
      ['case-table', 'new-table'].forEach(function (id) {
        var trs = document.getElementById(id).querySelectorAll('tbody tr');
        Array.prototype.forEach.call(trs, function (tr, j) { tr.classList.toggle('selected', j === i); });
      });
    }

    function show(i) {
      var x = rows[i], cm = x.caseM, nm = x.newM;
      slider.value = i;
      out.textContent = dollars(x.debt);
      slider.setAttribute('aria-valuetext', dollars(x.debt));
      document.getElementById('lever-rd').textContent = x.rd === null ? '—' : pct(x.rd);
      document.getElementById('lever-rs').textContent = pct(x.rs);

      var t = document.getElementById('lever-table');
      t.innerHTML = '';
      var head = el('thead'), hr = el('tr');
      ['At ' + dollars(x.debt), 'Case method ($' + plain(c.price, 2) + ' buyback)', 'New-price method'].forEach(function (h) {
        hr.appendChild(el('th', { scope: 'col' }, h));
      });
      head.appendChild(hr);
      t.appendChild(head);
      var body = el('tbody');
      [
        ['Share price', cents(cm.price), cents(nm.price)],
        ['Shares repurchased', count(cm.repurchased), count(nm.repurchased)],
        ['Shares remaining', count(cm.remaining), count(nm.remaining)],
        ['EPS', cents(cm.eps), cents(nm.eps)],
        ['Dividends per share', cents(cm.dps), cents(nm.dps)],
        ['TIE', times(cm.tie), times(nm.tie)],
        ['WACC', pct(cm.wacc) + ' (book weights)', pct(nm.wacc) + ' (market weights)'],
        ['Management\'s share', stakeText(cm.mgmt), stakeText(nm.mgmt)]
      ].forEach(function (cells) {
        var tr = el('tr');
        tr.appendChild(el('th', { scope: 'row' }, cells[0]));
        tr.appendChild(el('td', null, cells[1]));
        tr.appendChild(el('td', null, cells[2]));
        body.appendChild(tr);
      });
      t.appendChild(body);

      var notes = [];
      if (cm.mgmt.status === 'all' || nm.mgmt.status === 'all') {
        notes.push('* The buyback retires every outside share, so no outside shareholders would be left.');
      }
      if (cm.mgmt.status === 'sell' || nm.mgmt.status === 'sell') {
        notes.push('Warning: the buyback needs more shares than outside investors own, so management would have to sell some of its own.');
      }
      notes.push('Management owns ' + pct(c.managementShare) + ' today and does not sell, so its share = ' +
        pct(c.managementShare) + ' × ' + plain(c.shares, 0) + ' / shares remaining.');
      document.getElementById('mgmt-note').textContent = notes.join(' ');
      markRow(i);
    }

    function goTo(target, caseIdx, newIdx, what, value) {
      if (target.index < 0) return;
      show(target.index);
      note.hidden = false;
      if (target.agree) {
        note.textContent = 'Both buyback methods give the ' + what + ' at ' + dollars(rows[target.index].debt) + '.';
      } else if (caseIdx >= 0 && newIdx >= 0) {
        note.textContent = 'The methods disagree: the case method gives the ' + what + ' at ' + dollars(rows[caseIdx].debt) +
          ' (' + value(rows[caseIdx].caseM) + ') and the new-price method at ' + dollars(rows[newIdx].debt) +
          ' (' + value(rows[newIdx].newM) + '). The slider went to the case method\'s amount.';
      } else {
        note.textContent = 'Only one method could be worked out here, so the slider went to its amount.';
      }
    }

    var b = res.best;
    slider.addEventListener('input', function () { note.hidden = true; show(Number(slider.value)); });
    document.getElementById('btn-best-price').addEventListener('click', function () {
      goTo(b.priceButton, b.casePrice, b.newPrice, 'highest share price', function (m) { return cents(m.price); });
    });
    document.getElementById('btn-best-eps').addEventListener('click', function () {
      goTo(b.epsButton, b.caseEps, b.newEps, 'highest EPS', function (m) { return cents(m.eps); });
    });
    var start = rows.map(function (r) { return r.debt; }).indexOf(c.currentDebt);
    show(start < 0 ? 0 : start);
  }
})();
