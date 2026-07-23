// ============================================================
// APPLICATION — orchestration
// Récupère les données, calcule les indicateurs et le score,
// gère la persistance locale et le module de validation.
// ============================================================

const TICKERS = {
  spx: '^spx',
  spy: 'spy.us',
  rsp: 'rsp.us',
  vix: '^vix',
};

// Module Gave (cadran macro) — cadence MENSUELLE, tickers séparés, sources forcées Yahoo.
// interval='mo' + range='max' : on récupère tout l'historique disponible ; les données
// antérieures à ce que Yahoo couvre (or avant 2004, WTI en continu sans trou) proviennent
// du socle statique gave-seed-data.js, fusionné par gave-engine.js (cf. mergeSeedAndLive).
const GAVE_TICKERS = {
  gld: { ticker: 'gld.us', source: 'yahoo' },
  tlt: { ticker: 'tlt.us', source: 'yahoo' },
  spy: { ticker: 'spy.us', source: 'yahoo' },
  wti: { ticker: 'CL=F', source: 'yahoo' }, // symbole Yahoo natif — cl.f n'existe dans aucun mapping
};

const DEFAULT_PARAMS = {
  emaFast: 21,
  emaSlow: 50,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
};

const DEFAULT_WEIGHTS = {
  tendance: 25,
  momentum: 25,
  volatilite: 25,
  concentration: 25,
};

const STORAGE_KEY_HISTORY = 'marketRegimeHistory_v1';
const STORAGE_KEY_WEIGHTS = 'marketRegimeWeights_v1';
const STORAGE_KEY_PARAMS = 'marketRegimeParams_v1';

// --------------------------------------------------------------
// État applicatif en mémoire
// --------------------------------------------------------------
let appState = {
  weights: loadWeights(),
  params: loadParams(),
  lastResult: null,
  rawData: {},
};

// --------------------------------------------------------------
// Récupération des données (avec statut visible)
// --------------------------------------------------------------

async function fetchTicker(tickerKey, statusCallback) {
  const ticker = TICKERS[tickerKey];
  statusCallback(`Récupération de ${tickerKey.toUpperCase()} (${ticker})...`, 'pending');
  try {
    const res = await fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}&interval=w`);
    const json = await res.json();
    if (!res.ok || json.error) {
      statusCallback(`Échec ${tickerKey.toUpperCase()} : ${json.error || 'erreur inconnue'}`, 'err');
      return null;
    }
    statusCallback(`${tickerKey.toUpperCase()} OK (source: ${json.source}, ${json.count} bougies)`, 'ok');
    return json.data;
  } catch (e) {
    statusCallback(`Erreur réseau ${tickerKey.toUpperCase()} : ${e.message}`, 'err');
    return null;
  }
}

async function fetchAllData(statusCallback) {
  const [spx, spy, rsp, vix] = await Promise.all([
    fetchTicker('spx', statusCallback),
    fetchTicker('spy', statusCallback),
    fetchTicker('rsp', statusCallback),
    fetchTicker('vix', statusCallback),
  ]);
  return { spx, spy, rsp, vix };
}

// --------------------------------------------------------------
// Module Gave (cadran macro) — fetch dédié, source forcée Yahoo
// --------------------------------------------------------------

async function fetchGaveTicker(key, statusCallback) {
  const { ticker, source } = GAVE_TICKERS[key];
  statusCallback(`Récupération de ${key.toUpperCase()} (${ticker}, mensuel, ${source})...`, 'pending');
  try {
    const res = await fetch(`/api/prices?ticker=${encodeURIComponent(ticker)}&interval=mo&range=max&source=${source}`);
    const json = await res.json();
    if (!res.ok || json.error) {
      statusCallback(`Échec ${key.toUpperCase()} : ${json.error || 'erreur inconnue'}`, 'err');
      return null;
    }
    // GLD/WTI : pas de dividende, close = adjClose (champ parfois absent) ; TLT/SPY : adjClose requis.
    // Normalisation de la date au format YYYY-MM-01 pour être alignée avec le socle statique.
    const series = json.data
      .filter((c) => c.close !== null && c.close !== undefined)
      .map((c) => [c.date.slice(0, 7) + '-01', c.adjClose !== null && c.adjClose !== undefined ? c.adjClose : c.close]);
    statusCallback(`${key.toUpperCase()} OK (source: ${json.source}, ${series.length} mois)`, 'ok');
    return series;
  } catch (e) {
    statusCallback(`Erreur réseau ${key.toUpperCase()} : ${e.message}`, 'err');
    return null;
  }
}

async function fetchAllGaveData(statusCallback) {
  const [gld, tlt, spy, wti] = await Promise.all([
    fetchGaveTicker('gld', statusCallback),
    fetchGaveTicker('tlt', statusCallback),
    fetchGaveTicker('spy', statusCallback),
    fetchGaveTicker('wti', statusCallback),
  ]);
  return { gld, tlt, spy, wti };
}

const STORAGE_KEY_GAVE_CACHE = 'marketRegimeGaveCache_v1';
const GAVE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours — mise à jour mensuelle

function loadGaveCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GAVE_CACHE);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* cache absent ou corrompu */ }
  return null;
}

function saveGaveCache(result) {
  try {
    localStorage.setItem(STORAGE_KEY_GAVE_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), result }));
  } catch (e) { /* quota localStorage dépassé : tant pis, pas bloquant */ }
}

function isGaveCacheFresh(cache) {
  if (!cache || !cache.fetchedAt) return false;
  return (Date.now() - new Date(cache.fetchedAt).getTime()) < GAVE_CACHE_MAX_AGE_MS;
}

/**
 * Calcule (ou réutilise depuis le cache mensuel) le module Gave.
 * Ne dépend plus des données ^spx du module hebdomadaire : le module Gave
 * utilise désormais SPY comme proxy actions (cohérent avec sa propre cadence
 * mensuelle et déjà récupéré pour la Règle 2).
 */
async function runGaveAnalysis(statusCallback, forceRefresh = false) {
  const cache = loadGaveCache();
  if (!forceRefresh && isGaveCacheFresh(cache)) {
    statusCallback('Module Gave : cache mensuel réutilisé (moins de 30 jours).', 'ok');
    return cache.result;
  }

  const gaveData = await fetchAllGaveData(statusCallback);
  const result = computeGaveIndicators({
    gldLive: gaveData.gld,
    tlt: gaveData.tlt,
    spy: gaveData.spy,
    wtiLive: gaveData.wti,
  }, { GOLD_SEED, WTI_SEED });

  if (result.success) {
    saveGaveCache(result);
    statusCallback('Module Gave : calcul réussi, mis en cache pour 30 jours.', 'ok');
  } else {
    statusCallback(`Module Gave : ${result.errors.join(' ')}`, 'err');
  }
  return result;
}

// --------------------------------------------------------------
// Calcul complet : indicateurs + score
// --------------------------------------------------------------

function computeAnalysis(rawData, params, weights) {
  const errors = [];

  if (!rawData.spx || rawData.spx.length < 60) {
    errors.push("Données S&P 500 (^spx) insuffisantes ou manquantes.");
  }
  if (!rawData.spy || rawData.spy.length < 20) errors.push('Données SPY manquantes.');
  if (!rawData.rsp || rawData.rsp.length < 20) errors.push('Données RSP manquantes.');
  if (!rawData.vix || rawData.vix.length < 5) errors.push('Données VIX manquantes.');

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Exclusion de la semaine en cours (non close) sur la série principale
  const spx = excludeCurrentIncompleteWeek(rawData.spx);
  const spy = excludeCurrentIncompleteWeek(rawData.spy);
  const rsp = excludeCurrentIncompleteWeek(rawData.rsp);
  const vixSeries = excludeCurrentIncompleteWeek(rawData.vix);

  if (spx.length < 60) {
    return { success: false, errors: ['Historique S&P 500 trop court après exclusion de la semaine en cours (minimum 60 bougies requis pour EMA50).'] };
  }

  const closes = spx.map((c) => c.close);

  const ema21Series = calculateEMA(closes, params.emaFast);
  const ema50Series = calculateEMA(closes, params.emaSlow);
  const rsiSeries = calculateRSI(closes, params.rsiPeriod);
  const macdResult = calculateMACD(closes, params.macdFast, params.macdSlow, params.macdSignal);
  const atrSeries = calculateATR(spx, params.atrPeriod);

  const lastIdx = spx.length - 1;

  const close = closes[lastIdx];
  const ema21 = ema21Series[lastIdx];
  const ema50 = ema50Series[lastIdx];
  const ema21Prev = ema21Series[lastIdx - 1];
  const rsi = rsiSeries[lastIdx];
  const macdHistogram = macdResult.histogram[lastIdx];
  const macdHistogramPrev = macdResult.histogram[lastIdx - 1];
  const atr = atrSeries[lastIdx];
  const atrPct = (atr / close) * 100;

  if ([ema21, ema50, ema21Prev, rsi, macdHistogram, macdHistogramPrev, atr].some((v) => Number.isNaN(v))) {
    return { success: false, errors: ["Historique insuffisant pour calculer un ou plusieurs indicateurs (EMA/RSI/MACD/ATR). Il faut au moins ~60 semaines de données."] };
  }

  const vix = vixSeries[vixSeries.length - 1].close;

  // Ratio SPY/RSP — alignement par date sur les N dernières bougies communes
  const ratioSeries = buildRatioSeries(spy, rsp);
  if (ratioSeries.length < 10) {
    return { success: false, errors: ['Historique insuffisant pour calculer le ratio SPY/RSP (concentration).'] };
  }
  const ratioSpyRsp = ratioSeries[ratioSeries.length - 1].value;
  const ratioMA = averageOf(ratioSeries.slice(-10).map((r) => r.value)); // moyenne mobile 10 semaines du ratio

  // --- Scores par pilier ---
  const tendance = scoreTendance({ close, ema21, ema50 });
  const momentum = scoreMomentum({ rsi, macdHistogram, macdHistogramPrev });
  const volatilite = scoreVolatilite({ vix, atrPct });
  const concentration = scoreConcentration({ ratioSpyRsp, ratioSpyRspMA: ratioMA });

  const pillars = { tendance, momentum, volatilite, concentration };
  const globalResult = calculateGlobalScore(pillars, weights);
  const interpretation = interpretScore(globalResult.globalScore);

  // --- Chandelier (couche informative, hors score — cf cahier des charges §4bis) ---
  const candlestick = detectCandlestickPattern(spx.slice(-3));

  return {
    success: true,
    errors: [],
    date: spx[lastIdx].date,
    close,
    indicators: { ema21, ema50, rsi, macdHistogram, atr, atrPct, vix, ratioSpyRsp, ratioMA },
    pillars,
    globalScore: globalResult.globalScore,
    weights: globalResult.weights,
    interpretation,
    candlestick,
  };
}

/**
 * Construit une série du ratio SPY/RSP, alignée sur les dates communes aux deux séries.
 */
function buildRatioSeries(spy, rsp) {
  const rspByDate = new Map(rsp.map((c) => [c.date, c.close]));
  const result = [];
  for (const c of spy) {
    if (rspByDate.has(c.date)) {
      result.push({ date: c.date, value: c.close / rspByDate.get(c.date) });
    }
  }
  return result;
}

function averageOf(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --------------------------------------------------------------
// Persistance — historique, poids, paramètres
// --------------------------------------------------------------

function loadWeights() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WEIGHTS);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore, fallback ci-dessous */ }
  return { ...DEFAULT_WEIGHTS };
}

function saveWeights(weights) {
  localStorage.setItem(STORAGE_KEY_WEIGHTS, JSON.stringify(weights));
}

function loadParams() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PARAMS);
    if (raw) return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch (e) { /* ignore, fallback ci-dessous */ }
  return { ...DEFAULT_PARAMS };
}

function saveParams(params) {
  localStorage.setItem(STORAGE_KEY_PARAMS, JSON.stringify(params));
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* historique corrompu ou absent */ }
  return [];
}

function saveHistory(history) {
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
}

/**
 * Ajoute une nouvelle entrée à l'historique si la date n'y figure pas déjà
 * (évite les doublons si l'utilisateur relance le calcul sur la même semaine).
 */
function addHistoryEntry(analysis) {
  const history = loadHistory();
  const existingIdx = history.findIndex((h) => h.date === analysis.date);

  const entry = {
    date: analysis.date,
    timestamp: new Date().toISOString(),
    close: analysis.close,
    globalScore: analysis.globalScore,
    interpretation: analysis.interpretation,
    pillars: analysis.pillars,
    weights: analysis.weights,
    indicators: analysis.indicators,
    candlestick: analysis.candlestick,
    validation: existingIdx !== -1 ? history[existingIdx].validation : { perf1w: null, perf1m: null, perf3m: null },
  };

  if (existingIdx !== -1) {
    history[existingIdx] = entry;
  } else {
    history.push(entry);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));
  saveHistory(history);
  return history;
}

/**
 * Module de validation (cahier des charges §8) : pour chaque entrée d'historique
 * dont la validation n'est pas encore complète, tente de calculer la performance
 * réelle du S&P 500 à +1 semaine / +1 mois (~4 semaines) / +3 mois (~13 semaines).
 */
function updateValidation(history, spxCandlesFull) {
  const excluded = excludeCurrentIncompleteWeek(spxCandlesFull);
  const dateIndex = new Map(excluded.map((c, i) => [c.date, i]));

  let updated = false;
  for (const entry of history) {
    const needsUpdate = entry.validation.perf1w === null || entry.validation.perf1m === null || entry.validation.perf3m === null;
    if (!needsUpdate) continue;

    const idx = dateIndex.get(entry.date);
    if (idx === undefined) continue;

    if (entry.validation.perf1w === null && excluded[idx + 1]) {
      entry.validation.perf1w = pctChange(entry.close, excluded[idx + 1].close);
      updated = true;
    }
    if (entry.validation.perf1m === null && excluded[idx + 4]) {
      entry.validation.perf1m = pctChange(entry.close, excluded[idx + 4].close);
      updated = true;
    }
    if (entry.validation.perf3m === null && excluded[idx + 13]) {
      entry.validation.perf3m = pctChange(entry.close, excluded[idx + 13].close);
      updated = true;
    }
  }

  if (updated) saveHistory(history);
  return { history, updated };
}

function pctChange(from, to) {
  return Math.round(((to - from) / from) * 1000) / 10; // arrondi à 0.1%
}

// --------------------------------------------------------------
// Export / Import JSON
// --------------------------------------------------------------

function exportHistoryToJson() {
  const history = loadHistory();
  const weights = loadWeights();
  const params = loadParams();
  const payload = { exportedAt: new Date().toISOString(), history, weights, params };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `historique-regime-marche-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importHistoryFromJson(file, onDone, onError) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const payload = JSON.parse(e.target.result);
      if (!Array.isArray(payload.history)) throw new Error('Format invalide : champ "history" manquant ou incorrect.');
      saveHistory(payload.history);
      if (payload.weights) saveWeights(payload.weights);
      if (payload.params) saveParams(payload.params);
      onDone(payload);
    } catch (err) {
      onError(err);
    }
  };
  reader.onerror = () => onError(new Error('Impossible de lire le fichier.'));
  reader.readAsText(file);
}
