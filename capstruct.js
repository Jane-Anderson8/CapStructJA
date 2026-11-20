/*
 * capstruct.js — the finance math for the AGE capital structure app.
 *
 * Every function here is plain math: none of them touch the page. That lets
 * us check them with Node, for example:
 *   node -e "const c=require('./capstruct.js'); console.log(c.roundHalfUp(0.14025*100,2))"
 *
 * Notation (from CLAUDE.md): T = tax rate, D = amount borrowed,
 * n = shares outstanding before any buyback, P0 = today's price,
 * A = total book assets.
 */
(function (root) {
  'use strict';

  // ---------- Rounding ----------

  // Round half up on the decimal value. JavaScript's toFixed rounds the
  // binary value, so 14.025 can come out as 14.02. toPrecision(12) first
  // strips the tiny binary error, then Math.round rounds the true decimal.
  // Negative numbers round half away from zero.
  function roundHalfUp(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return x;
    var f = Math.pow(10, d);
    var scaled = Number((Math.abs(x) * f).toPrecision(12));
    return (x < 0 ? -1 : 1) * Math.round(scaled) / f;
  }

  // ---------- CSV reading ----------

  // Parse a small CSV file into an array of objects keyed by the header row.
  // Handles quoted fields, so a note with a comma in quotes still works.
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    text = String(text).replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); });
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var obj = {};
      header.forEach(function (h, j) { obj[h] = (r[j] === undefined ? '' : r[j].trim()); });
      return obj;
    });
  }

  // '' becomes null (for example the $0 row's missing cost of debt).
  function toNumber(s) {
    if (s === null || s === undefined || String(s).trim() === '') return null;
    var v = Number(s);
    if (!isFinite(v)) throw new Error('Not a number: "' + s + '"');
    return v;
  }

  // Turn rows like {item, value} into {item: number}.
  function keyValues(rows, keyCol, valCol) {
    var out = {};
    rows.forEach(function (r) { out[r[keyCol]] = toNumber(r[valCol]); });
    return out;
  }

  function require_(obj, keys, file) {
    keys.forEach(function (k) {
      if (obj[k] === null || obj[k] === undefined) {
        throw new Error(file + ' is missing "' + k + '".');
      }
    });
  }

  // ---------- Reading each data file ----------

  function readAssumptions(rows) {
    var a = keyValues(rows, 'assumption', 'value');
    require_(a, ['tax_rate'], 'data/assumptions.csv');
    return { taxRate: a.tax_rate };
  }

  function readCDSS(rows) {
    var v = keyValues(rows, 'item', 'value');
    require_(v, ['sales', 'variable_cost_rate', 'fixed_costs', 'total_assets',
      'shares_outstanding', 'share_price', 'management_share'], 'data/cdss.csv');
    return {
      sales: v.sales,
      variableCostRate: v.variable_cost_rate,
      fixedCosts: v.fixed_costs,
      totalAssets: v.total_assets,
      currentDebt: v.debt || 0,
      shares: v.shares_outstanding,
      price: v.share_price,
      managementShare: v.management_share
    };
  }

  // Banker's schedule, sorted by debt. Only the $0 row may lack a cost of debt.
  function readSchedule(rows, file) {
    file = file || 'the banker schedule';
    var sched = rows.map(function (r) {
      return {
        debt: toNumber(r.debt),
        rd: toNumber(r.cost_of_debt),
        rs: toNumber(r.cost_of_equity)
      };
    });
    sched.sort(function (a, b) { return a.debt - b.debt; });
    if (!sched.length) throw new Error(file + ' has no rows.');
    sched.forEach(function (s) {
      if (s.debt === null) throw new Error(file + ' has a row with no debt amount.');
      if (s.rs === null || s.rs <= 0) throw new Error(file + ': the cost of equity at $' + s.debt + ' is missing or not positive.');
      if (s.debt > 0 && s.rd === null) throw new Error(file + ': the cost of debt at $' + s.debt + ' is missing.');
    });
    return sched;
  }

  function readExampleFirms(rows) {
    var v = keyValues(rows, 'item', 'value');
    require_(v, ['total_assets', 'firm_l_debt', 'interest_rate', 'slider_max', 'slider_step'], 'data/example_firms.csv');
    return {
      totalAssets: v.total_assets,
      firmLDebt: v.firm_l_debt,
      interestRate: v.interest_rate,
      sliderMax: v.slider_max,
      sliderStep: v.slider_step
    };
  }

  function readScenarios(rows) {
    return rows.map(function (r) {
      return {
        probability: toNumber(r.probability),
        sales: toNumber(r.sales),
        operatingCosts: toNumber(r.operating_costs)
      };
    });
  }

  // Dollar amount for warning messages, e.g. 250000 -> "$250,000".
  function money(x) {
    return '$' + String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ---------- Statistics ----------

  // Expected value = probability-weighted average.
  function expected(values, probs) {
    return values.reduce(function (s, v, i) { return s + probs[i] * v; }, 0);
  }

  // Standard deviation = square root of probability-weighted squared deviations.
  function stdDev(values, probs) {
    var m = expected(values, probs);
    return Math.sqrt(values.reduce(function (s, v, i) { return s + probs[i] * (v - m) * (v - m); }, 0));
  }

  // ---------- Firm U and Firm L (question c) ----------

  // One firm's income statement in each kind of year, plus the ratios.
  // With no debt, TIE and its statistics are null (shown as "n/a").
  function firm(opts) {
    var A = opts.totalAssets, D = opts.debt, T = opts.taxRate;
    var equity = A - D;
    var interest = opts.interestRate * D;
    var years = opts.scenarios.map(function (s) {
      var ebit = s.sales - s.operatingCosts;
      var ebt = ebit - interest;
      var taxes = T * ebt;
      var ni = ebt - taxes;
      return {
        probability: s.probability,
        sales: s.sales,
        operatingCosts: s.operatingCosts,
        ebit: ebit,
        interest: interest,
        ebt: ebt,
        taxes: taxes,
        netIncome: ni,
        roe: ni / equity,
        tie: interest > 0 ? ebit / interest : null
      };
    });
    var p = years.map(function (y) { return y.probability; });
    var roe = years.map(function (y) { return y.roe; });
    var eRoe = expected(roe, p);
    var sRoe = stdDev(roe, p);
    var out = {
      assets: A,
      debt: D,
      equity: equity,
      years: years,
      eRoe: eRoe,
      sdRoe: sRoe,
      cvRoe: sRoe / eRoe,
      eTie: null,
      sdTie: null
    };
    if (interest > 0) {
      var tie = years.map(function (y) { return y.tie; });
      out.eTie = expected(tie, p);
      out.sdTie = stdDev(tie, p);
    }
    return out;
  }

  // Firm U (no debt) and Firm L (debtL, default the case's $10,000).
  // The 12% rate is held at every amount of debt.
  function exampleFirms(ex, scenarios, taxRate, debtL) {
    if (debtL === undefined) debtL = ex.firmLDebt;
    var base = { totalAssets: ex.totalAssets, interestRate: ex.interestRate, taxRate: taxRate, scenarios: scenarios };
    return {
      U: firm(Object.assign({}, base, { debt: 0 })),
      L: firm(Object.assign({}, base, { debt: debtL }))
    };
  }

  // ---------- CDSS ----------

  // EBIT = sales x (1 - variable cost rate) - fixed costs. Constant at every D.
  function cdssEBIT(c) {
    return c.sales * (1 - c.variableCostRate) - c.fixedCosts;
  }

  // Case method (d(3), d(4)): buy back at today's price P0.
  function caseMethod(c, ebit, T, row) {
    var D = row.debt, n = c.shares, P0 = c.price, A = c.totalAssets;
    var rd = row.rd || 0, rs = row.rs;
    var interest = rd * D;
    var ni = (ebit - interest) * (1 - T);
    var repurchased = D / P0;
    var remaining = n - repurchased;
    var feasible = remaining > 0;
    var eps = feasible ? ni / remaining : null;
    return {
      interest: interest,
      netIncome: ni,
      repurchased: repurchased,
      remaining: remaining,
      feasible: feasible,
      eps: eps,
      tie: interest > 0 ? ebit / interest : null,
      price: feasible ? eps / rs : null,
      // Book weights, the AGE solution's method for d(7).
      wacc: D / A * rd * (1 - T) + (A - D) / A * rs
    };
  }

  // New-price method: buy back at the price after the announcement.
  function newPriceMethod(c, ebit, T, row) {
    var D = row.debt, n = c.shares;
    var rd = row.rd || 0, rs = row.rs;
    var interest = rd * D;
    var ni = (ebit - interest) * (1 - T);
    var S = ni / rs;              // value of equity
    var V = S + D;                // value of the firm
    var P = V / n;                // price per share
    var repurchased = D / P;
    var remaining = n - repurchased;
    var eps = ni / remaining;
    var wacc = D / V * rd * (1 - T) + S / V * rs;   // market weights
    var waccCheck = ebit * (1 - T) / V;
    return {
      interest: interest,
      netIncome: ni,
      equityValue: S,
      firmValue: V,
      price: P,
      repurchased: repurchased,
      remaining: remaining,
      feasible: remaining > 0 && S > 0,
      eps: eps,
      tie: interest > 0 ? ebit / interest : null,
      wacc: wacc,
      // Checks: EPS = r_s x P, and WACC = EBIT(1 - T) / V.
      epsCheckOk: Math.abs(eps - rs * P) < 1e-9,
      waccCheckOk: Math.abs(wacc - waccCheck) < 1e-12
    };
  }

  // Index of the best row. better(a, b) is true when a beats b.
  // Rows are in ascending debt, so on an exact tie the smaller debt wins.
  function bestIndex(rows, value, higherIsBetter) {
    var best = -1;
    rows.forEach(function (r, i) {
      var v = value(r);
      if (v === null || v === undefined || !isFinite(v)) return;
      if (best < 0) { best = i; return; }
      var b = value(rows[best]);
      if (higherIsBetter ? v > b + 1e-12 : v < b - 1e-12) best = i;
    });
    return best;
  }

  // Everything for CDSS at each amount of borrowing in the schedule.
  function analyzeCDSS(c, schedule, T) {
    var ebit = cdssEBIT(c);
    var rows = schedule.map(function (s) {
      return {
        debt: s.debt,
        rd: s.rd,
        rs: s.rs,
        caseM: caseMethod(c, ebit, T, s),
        newM: newPriceMethod(c, ebit, T, s)
      };
    });

    var warnings = [];
    // Check: EPS / r_s at $0 should equal today's share price in cdss.csv.
    var zero = rows.filter(function (r) { return r.debt === 0; })[0];
    var zeroCheck = { ok: false, implied: null, actual: c.price };
    if (!zero) {
      warnings.push('The schedule has no $0 row, so the app cannot check today\'s share price.');
    } else {
      zeroCheck.implied = zero.caseM.eps / zero.rs;
      zeroCheck.ok = Math.abs(zeroCheck.implied - c.price) < 0.005;
      if (!zeroCheck.ok) {
        warnings.push('At $0 of debt, EPS / r_s gives $' + roundHalfUp(zeroCheck.implied, 2).toFixed(2) +
          ', but cdss.csv says today\'s price is $' + roundHalfUp(c.price, 2).toFixed(2) +
          '. The schedule\'s cost of equity at $0 does not match the market data.');
      }
    }
    rows.forEach(function (r) {
      if (!r.caseM.feasible) warnings.push('At ' + money(r.debt) + ' of debt, buying back at $' + roundHalfUp(c.price, 2).toFixed(2) + ' would retire every share. That row cannot be priced.');
      if (!r.newM.epsCheckOk) warnings.push('New-price check failed at ' + money(r.debt) + ': EPS does not equal r_s × P.');
      if (!r.newM.waccCheckOk) warnings.push('New-price check failed at ' + money(r.debt) + ': market WACC does not equal EBIT(1 − T) / V.');
    });

    var best = {
      casePrice: bestIndex(rows, function (r) { return r.caseM.feasible ? r.caseM.price : null; }, true),
      newPrice: bestIndex(rows, function (r) { return r.newM.feasible ? r.newM.price : null; }, true),
      bookWacc: bestIndex(rows, function (r) { return r.caseM.wacc; }, false),
      marketWacc: bestIndex(rows, function (r) { return r.newM.feasible ? r.newM.wacc : null; }, false),
      caseEps: bestIndex(rows, function (r) { return r.caseM.eps; }, true),
      newEps: bestIndex(rows, function (r) { return r.newM.feasible ? r.newM.eps : null; }, true)
    };
    var picks = [best.casePrice, best.newPrice, best.bookWacc, best.marketWacc];
    best.allAgree = picks.every(function (i) { return i === picks[0] && i >= 0; });

    return { ebit: ebit, taxRate: T, rows: rows, best: best, zeroCheck: zeroCheck, warnings: warnings };
  }

  var api = {
    roundHalfUp: roundHalfUp,
    parseCSV: parseCSV,
    toNumber: toNumber,
    readAssumptions: readAssumptions,
    readCDSS: readCDSS,
    readSchedule: readSchedule,
    readExampleFirms: readExampleFirms,
    readScenarios: readScenarios,
    expected: expected,
    stdDev: stdDev,
    firm: firm,
    exampleFirms: exampleFirms,
    cdssEBIT: cdssEBIT,
    caseMethod: caseMethod,
    newPriceMethod: newPriceMethod,
    analyzeCDSS: analyzeCDSS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CapStruct = api;
})(typeof self !== 'undefined' ? self : this);
