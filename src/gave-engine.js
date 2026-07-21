// ============================================================
// GAVE-ENGINE — Cadran macro (Croissance × Inflation)
// Deux ratios de prix, chacun comparé à sa propre moyenne mobile
// à 7 ans (364 semaines). Aucune donnée macro, aucune fuite :
// à l'indice i, la MM7ans ne dépend que des points <= i.
// ============================================================

const MA_WINDOW_WEEKS = 7 * 52; // 364 semaines

/**
 * Aligne deux séries [date, valeur] sur leurs dates communes et calcule
 * le ratio a/b pour chaque date commune, trié par date croissante.
 * @returns {Array<{date: string, value: number}>}
 */
function buildRatioSeriesFromPairs(seriesA, seriesB) {
  const mapA = seriesA instanceof Map ? seriesA : new Map(seriesA);
  const mapB = seriesB instanceof Map ? seriesB : new Map(seriesB);
  const dates = [...mapA.keys()].filter((d) => mapB.has(d)).sort();
  return dates.map((date) => ({ date, value: mapA.get(date) / mapB.get(date) }));
}

/**
 * Moyenne mobile sur une fenêtre de `windowWeeks` points, walk-forward
 * (la valeur à l'indice i ne dépend que des points <= i).
 * @returns {Array<number|null>} même longueur que `series`, null tant que
 *   la fenêtre n'est pas remplie.
 */
function movingAverage(series, windowWeeks) {
  const result = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    if (i < windowWeeks - 1) continue;
    let sum = 0;
    for (let j = i - windowWeeks + 1; j <= i; j++) sum += series[j].value;
    result[i] = sum / windowWeeks;
  }
  return result;
}

/**
 * Écart en % entre la dernière valeur d'une série de ratios et sa MM7ans.
 * @returns {{ecartPct: number, ratio: number, ma: number, date: string}|null}
 *   null si la MM7ans n'est pas encore calculable (historique < 7 ans).
 */
function lastEcartVsMA(ratioSeries, windowWeeks = MA_WINDOW_WEEKS) {
  const ma = movingAverage(ratioSeries, windowWeeks);
  for (let i = ratioSeries.length - 1; i >= 0; i--) {
    if (ma[i] !== null) {
      const ratio = ratioSeries[i].value;
      return {
        ecartPct: ((ratio - ma[i]) / ma[i]) * 100,
        ratio,
        ma: ma[i],
        date: ratioSeries[i].date,
      };
    }
  }
  return null;
}

/**
 * Détermine le cadran (au sens de Gave) à partir des deux écarts.
 * X = écart Croissance (S&P/WTI vs MM7ans), Y = écart Inflation (Or/Obligations vs MM7ans).
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
 * Calcule l'ensemble des indicateurs du module Gave.
 * @param {object} data - séries brutes [[date, close], ...] pour chaque actif
 * @param {Array} data.gld - or (pas de dividende, close = adjClose)
 * @param {Array} data.tlt - obligations longues US, valeurs AJUSTÉES (coupons réinvestis)
 * @param {Array} data.spyAdj - actions US, valeurs AJUSTÉES (dividendes réinvestis)
 * @param {Array} data.wti - pétrole WTI continu
 * @param {Array} data.spx - S&P 500 (indice de prix, pas de dividende à ajuster ici : comparé à l'énergie, pas à un autre actif financier)
 * @returns {object} résultat complet ou { success:false, errors:[...] }
 */
function computeGaveIndicators({ gld, tlt, spyAdj, wti, spx }) {
  const errors = [];
  const MIN_POINTS = MA_WINDOW_WEEKS + 1;

  if (!gld || gld.length < MIN_POINTS) errors.push('Historique Or (GLD) insuffisant pour la MM7ans (7 ans requis).');
  if (!tlt || tlt.length < MIN_POINTS) errors.push('Historique Obligations (TLT ajusté) insuffisant pour la MM7ans.');
  if (!spyAdj || spyAdj.length < MIN_POINTS) errors.push('Historique Actions (SPY ajusté) insuffisant pour la MM7ans.');
  if (!wti || wti.length < MIN_POINTS) errors.push('Historique WTI insuffisant pour la MM7ans.');
  if (!spx || spx.length < MIN_POINTS) errors.push('Historique S&P 500 insuffisant pour la MM7ans.');
  if (errors.length > 0) return { success: false, errors };

  const ratioOrObligations = buildRatioSeriesFromPairs(gld, tlt);
  const ratioActionsOr = buildRatioSeriesFromPairs(spyAdj, gld);
  const ratioCroissance = buildRatioSeriesFromPairs(spx, wti);

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
    inflation, // Règle 1 : Or / Obligations
    croissance, // Axe croissance : S&P / WTI
    actionsOr, // Règle 2 : Actions / Or (indicateur complémentaire)
    quadrant,
    regle1Signal: inflation.ecartPct > 0 ? 'OR' : 'OBLIGATIONS',
    regle2Signal: actionsOr.ecartPct > 0 ? 'ACTIONS' : 'OR (alerte)',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MA_WINDOW_WEEKS,
    buildRatioSeriesFromPairs,
    movingAverage,
    lastEcartVsMA,
    classifyQuadrant,
    computeGaveIndicators,
  };
}
