// ============================================================
// GAVE-ENGINE — Cadran macro (Croissance × Inflation)
// Cadence MENSUELLE (cohérente avec la méthode de Gave — moyennes
// mobiles à 7 ans pensées pour du mensuel, pas de l'hebdomadaire).
// Deux ratios de prix, chacun comparé à sa propre moyenne mobile à
// 7 ans (84 mois). Walk-forward par construction : à l'indice i, la
// MM7ans ne dépend que des points <= i.
//
// Historique : combine un socle statique embarqué (gave-seed-data.js)
// avec les données récupérées en direct par l'app, pour les séries
// que Yahoo/Stooq ne couvrent pas assez loin dans le passé (or avant
// 2004, WTI en continu sans trou). Cf. commentaires de
// gave-seed-data.js pour la provenance et la méthode de raccord.
// ============================================================

const MA_WINDOW_MONTHS = 84; // 7 ans

/**
 * Fusionne un socle statique et une série récupérée en direct.
 * Le socle prévaut sur toute date qu'il couvre ; le live ne complète
 * qu'au-delà de la dernière date du socle. En cas de trou dans le
 * live après la jonction, report de la dernière valeur connue
 * (forward-fill) plutôt qu'interpolation — convention standard pour
 * des trous ponctuels sur une moyenne mobile longue.
 * @param {Array<[string, number]>} seed - trié par date croissante
 * @param {Array<[string, number]>} live - trié par date croissante
 * @returns {Map<string, number>}
 */
function mergeSeedAndLive(seed, live) {
  const result = new Map(seed);
  const lastSeedDate = seed.length > 0 ? seed[seed.length - 1][0] : null;
  const liveAfterSeed = live.filter(([date]) => !lastSeedDate || date > lastSeedDate);

  if (liveAfterSeed.length === 0) return result;

  // Détecte les mois manquants entre la fin du socle et le premier point live,
  // et entre points live consécutifs -> report de la dernière valeur connue.
  let cursor = lastSeedDate ? new Date(lastSeedDate + 'T00:00:00Z') : null;
  let lastKnownValue = cursor ? result.get(lastSeedDate) : null;

  for (const [date, value] of liveAfterSeed) {
    if (cursor) {
      let next = new Date(cursor.getTime());
      next.setUTCMonth(next.getUTCMonth() + 1);
      while (next < new Date(date + 'T00:00:00Z')) {
        const fillDate = next.toISOString().slice(0, 7) + '-01';
        if (!result.has(fillDate)) result.set(fillDate, lastKnownValue);
        next.setUTCMonth(next.getUTCMonth() + 1);
      }
    }
    result.set(date, value);
    cursor = new Date(date + 'T00:00:00Z');
    lastKnownValue = value;
  }
  return result;
}

/**
 * Aligne deux séries [date, valeur] sur leurs dates communes et calcule
 * le ratio a/b pour chaque date commune, trié par date croissante.
 */
function buildRatioSeriesFromPairs(seriesA, seriesB) {
  const mapA = seriesA instanceof Map ? seriesA : new Map(seriesA);
  const mapB = seriesB instanceof Map ? seriesB : new Map(seriesB);
  const dates = [...mapA.keys()].filter((d) => mapB.has(d)).sort();
  return dates.map((date) => ({ date, value: mapA.get(date) / mapB.get(date) }));
}

/**
 * Moyenne mobile sur une fenêtre de `windowMonths` points, walk-forward.
 */
function movingAverage(series, windowMonths) {
  const result = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    if (i < windowMonths - 1) continue;
    let sum = 0;
    for (let j = i - windowMonths + 1; j <= i; j++) sum += series[j].value;
    result[i] = sum / windowMonths;
  }
  return result;
}

/**
 * Écart en % entre la dernière valeur d'une série de ratios et sa MM7ans.
 */
function lastEcartVsMA(ratioSeries, windowMonths = MA_WINDOW_MONTHS) {
  const ma = movingAverage(ratioSeries, windowMonths);
  for (let i = ratioSeries.length - 1; i >= 0; i--) {
    if (ma[i] !== null) {
      const ratio = ratioSeries[i].value;
      return { ecartPct: ((ratio - ma[i]) / ma[i]) * 100, ratio, ma: ma[i], date: ratioSeries[i].date };
    }
  }
  return null;
}

/**
 * Détermine le cadran à partir des deux écarts.
 * X = écart Croissance (Actions/WTI vs MM7ans), Y = écart Inflation (Or/Obligations vs MM7ans).
 */
function classifyQuadrant(ecartCroissance, ecartInflation) {
  const croissanceForte = ecartCroissance > 0;
  const inflationForte = ecartInflation > 0;
  if (croissanceForte && inflationForte) return { key: 'boom-inflationniste', label: 'Boom inflationniste', asset: 'Or' };
  if (!croissanceForte && inflationForte) return { key: 'recession-inflationniste', label: 'Récession inflationniste', asset: 'Cash' };
  if (croissanceForte && !inflationForte) return { key: 'boom-deflationniste', label: 'Boom déflationniste', asset: 'Actions' };
  return { key: 'deflation-depression', label: 'Déflation dépression', asset: 'Obligations' };
}

/**
 * Calcule l'ensemble des indicateurs du module Gave, en fusionnant les
 * socles statiques (or, WTI) avec les données récupérées en direct.
 * @param {object} data
 * @param {Array} data.gldLive - GLD récupéré en direct [[date, adjClose], ...]
 * @param {Array} data.tlt - TLT ajusté, récupéré en direct
 * @param {Array} data.spy - SPY ajusté, récupéré en direct
 * @param {Array} data.wtiLive - WTI (CL=F) récupéré en direct, peut contenir des trous
 * @param {object} seedData - { GOLD_SEED, WTI_SEED } importés de gave-seed-data.js
 */
function computeGaveIndicators({ gldLive, tlt, spy, wtiLive }, seedData) {
  const errors = [];
  const MIN_POINTS = MA_WINDOW_MONTHS + 1;

  if (!gldLive) errors.push('Données Or (GLD) manquantes.');
  if (!tlt || tlt.length < MIN_POINTS) errors.push('Historique Obligations (TLT) insuffisant pour la MM7ans.');
  if (!spy || spy.length < MIN_POINTS) errors.push('Historique Actions (SPY) insuffisant pour la MM7ans.');
  if (!wtiLive) errors.push('Données WTI manquantes.');
  if (!seedData || !seedData.GOLD_SEED || !seedData.WTI_SEED) errors.push('Socle historique (gave-seed-data.js) manquant.');
  if (errors.length > 0) return { success: false, errors };

  const gold = mergeSeedAndLive(seedData.GOLD_SEED, gldLive);
  const wti = mergeSeedAndLive(seedData.WTI_SEED, wtiLive);
  const tltMap = tlt instanceof Map ? tlt : new Map(tlt);
  const spyMap = spy instanceof Map ? spy : new Map(spy);

  const ratioOrObligations = buildRatioSeriesFromPairs(gold, tltMap);
  const ratioActionsOr = buildRatioSeriesFromPairs(spyMap, gold);
  const ratioCroissance = buildRatioSeriesFromPairs(spyMap, wti);

  const inflation = lastEcartVsMA(ratioOrObligations);
  const actionsOr = lastEcartVsMA(ratioActionsOr);
  const croissance = lastEcartVsMA(ratioCroissance);

  if (!inflation || !actionsOr || !croissance) {
    return { success: false, errors: ["Moins de 7 ans de données communes après alignement des dates — la MM7ans n'est pas encore calculable."] };
  }

  const quadrant = classifyQuadrant(croissance.ecartPct, inflation.ecartPct);

  return {
    success: true,
    errors: [],
    date: inflation.date,
    inflation,
    croissance,
    actionsOr,
    quadrant,
    regle1Signal: inflation.ecartPct > 0 ? 'OR' : 'OBLIGATIONS',
    regle2Signal: actionsOr.ecartPct > 0 ? 'ACTIONS' : 'OR (alerte)',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MA_WINDOW_MONTHS,
    mergeSeedAndLive,
    buildRatioSeriesFromPairs,
    movingAverage,
    lastEcartVsMA,
    classifyQuadrant,
    computeGaveIndicators,
  };
}
