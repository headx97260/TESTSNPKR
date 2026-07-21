// ============================================================
// Moteur de calcul — indicateurs techniques (JS pur, sans dépendance)
// Toutes les fonctions prennent un tableau de bougies OHLC triées par date croissante :
// [{ date, open, high, low, close, volume }, ...]
// ============================================================

/**
 * Exclut la dernière bougie si elle correspond à une semaine en cours (incomplète).
 * Règle : on ne calcule qu'après clôture hebdomadaire (vendredi soir US).
 * Heuristique : si la dernière bougie a une date dans les 6 derniers jours ET
 * qu'on n'est pas samedi/dimanche (jours où la semaine précédente est bien clôturée),
 * on considère la semaine en cours comme incomplète et on l'exclut.
 */
function excludeCurrentIncompleteWeek(candles, now = new Date()) {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  const lastDate = new Date(last.date + 'T00:00:00Z');

  // Jour de la semaine côté UTC : 0 = dimanche, 6 = samedi
  const dayOfWeek = now.getUTCDay();
  // On ne considère les données comme "à jour de la semaine" que le samedi/dimanche
  const weekIsClosed = dayOfWeek === 0 || dayOfWeek === 6;

  const diffDays = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);

  if (!weekIsClosed && diffDays < 7) {
    // La dernière bougie appartient probablement à la semaine en cours, non close
    return candles.slice(0, -1);
  }
  return candles;
}

/**
 * Moyenne Mobile Exponentielle (EMA)
 * @param {number[]} values - série de valeurs (ex: clôtures)
 * @param {number} period - période de l'EMA
 * @returns {number[]} série d'EMA, alignée sur `values` (NaN tant que non calculable)
 */
function calculateEMA(values, period) {
  const result = new Array(values.length).fill(NaN);
  if (values.length < period) return result;

  const k = 2 / (period + 1);

  // Amorçage : SMA des `period` premières valeurs
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  result[period - 1] = sma;

  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * RSI (Relative Strength Index), méthode de Wilder
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]} série de RSI (0-100), NaN tant que non calculable
 */
function calculateRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  result[period] = computeRsiFromAvg(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    result[i] = computeRsiFromAvg(avgGain, avgLoss);
  }
  return result;
}

function computeRsiFromAvg(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (12, 26, 9) par défaut
 * @returns {{ macd: number[], signal: number[], histogram: number[] }}
 */
function calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  const macdLine = closes.map((_, i) => {
    if (Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i])) return NaN;
    return emaFast[i] - emaSlow[i];
  });

  // La ligne de signal est une EMA de la ligne MACD, calculée uniquement
  // sur la portion de macdLine où elle est définie (pas de NaN).
  const firstValidIndex = macdLine.findIndex((v) => !Number.isNaN(v));
  const signalLine = new Array(closes.length).fill(NaN);

  if (firstValidIndex !== -1) {
    const validMacd = macdLine.slice(firstValidIndex);
    const emaOfMacd = calculateEMA(validMacd, signalPeriod);
    for (let i = 0; i < emaOfMacd.length; i++) {
      signalLine[firstValidIndex + i] = emaOfMacd[i];
    }
  }

  const histogram = closes.map((_, i) => {
    if (Number.isNaN(macdLine[i]) || Number.isNaN(signalLine[i])) return NaN;
    return macdLine[i] - signalLine[i];
  });

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * ATR (Average True Range), méthode de Wilder
 * @param {Array<{high:number, low:number, close:number}>} candles
 * @param {number} period
 * @returns {number[]}
 */
function calculateATR(candles, period = 14) {
  const result = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  const trueRanges = new Array(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
  }

  // Amorçage : moyenne simple des `period` premiers True Range (indices 1..period)
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRanges[i];
  let atr = sum / period;
  result[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    result[i] = atr;
  }
  return result;
}

/**
 * Détection de patterns de chandeliers — retourne le pattern détecté sur la
 * DERNIÈRE bougie du tableau fourni (utilise jusqu'à 3 bougies de contexte).
 * Couche informative uniquement — ne doit jamais influencer le score (cf. cahier des charges §4bis).
 */
function detectCandlestickPattern(candles) {
  if (candles.length === 0) return null;
  const c0 = candles[candles.length - 1]; // bougie actuelle
  const c1 = candles.length >= 2 ? candles[candles.length - 2] : null;
  const c2 = candles.length >= 3 ? candles[candles.length - 3] : null;

  const body = Math.abs(c0.close - c0.open);
  const range = c0.high - c0.low;
  if (range === 0) return null;

  const upperWick = c0.high - Math.max(c0.open, c0.close);
  const lowerWick = Math.min(c0.open, c0.close) - c0.low;
  const bodyRatio = body / range;

  // --- Patterns à une bougie ---
  if (bodyRatio < 0.1) {
    return { name: 'Doji', description: "Indécision — le marché n'a pas tranché de direction sur la semaine." };
  }

  if (lowerWick > body * 2 && upperWick < body * 0.5) {
    const isDowntrend = c1 ? c0.close < c1.close : false;
    return isDowntrend
      ? { name: 'Marteau', description: 'Rejet des prix bas — signal potentiel de retournement haussier, à confirmer.' }
      : { name: 'Marteau inversé (contexte haussier)', description: 'Mèche basse longue hors tendance baissière — signal moins significatif hors contexte.' };
  }

  if (upperWick > body * 2 && lowerWick < body * 0.5) {
    const isUptrend = c1 ? c0.close > c1.close : false;
    return isUptrend
      ? { name: 'Étoile filante / Pendu', description: 'Rejet des prix hauts — signal potentiel de retournement baissier, à confirmer.' }
      : { name: 'Mèche haute (contexte baissier)', description: 'Mèche haute longue hors tendance haussière — signal moins significatif hors contexte.' };
  }

  // --- Patterns à deux bougies ---
  if (c1) {
    const c1Body = Math.abs(c1.close - c1.open);
    const c0Bullish = c0.close > c0.open;
    const c1Bearish = c1.close < c1.open;
    const c0Bearish = c0.close < c0.open;
    const c1Bullish = c1.close > c1.open;

    // Avalement haussier : bougie baissière suivie d'une bougie haussière qui l'englobe
    if (c1Bearish && c0Bullish && c0.open <= c1.close && c0.close >= c1.open && body > c1Body) {
      return { name: 'Avalement haussier', description: 'La bougie haussière englobe totalement la bougie baissière précédente — momentum acheteur fort.' };
    }
    // Avalement baissier
    if (c1Bullish && c0Bearish && c0.open >= c1.close && c0.close <= c1.open && body > c1Body) {
      return { name: 'Avalement baissier', description: 'La bougie baissière englobe totalement la bougie haussière précédente — momentum vendeur fort.' };
    }
    // Harami (contraire de l'avalement : la bougie actuelle est contenue dans la précédente)
    if (body < c1Body && c0.open <= Math.max(c1.open, c1.close) && c0.close >= Math.min(c1.open, c1.close)
        && c0.high <= Math.max(c1.open, c1.close) + 0.0001 && c0.low >= Math.min(c1.open, c1.close) - 0.0001) {
      return { name: 'Harami', description: 'Contraction nette de la volatilité après une bougie marquée — indécision, changement de rythme possible.' };
    }
  }

  // --- Patterns à trois bougies ---
  if (c1 && c2) {
    const c2Bearish = c2.close < c2.open;
    const c2Bullish = c2.close > c2.open;
    const c0Bullish = c0.close > c0.open;
    const c0Bearish = c0.close < c0.open;
    const c1SmallBody = Math.abs(c1.close - c1.open) < Math.abs(c2.close - c2.open) * 0.5;

    // Étoile du matin : bougie baissière, petite bougie (indécision), bougie haussière qui referme dans le corps de la 1ère
    if (c2Bearish && c1SmallBody && c0Bullish && c0.close > (c2.open + c2.close) / 2) {
      return { name: 'Étoile du matin', description: 'Séquence de retournement haussier sur trois semaines — épuisement vendeur suivi d’un retour acheteur.' };
    }
    // Étoile du soir
    if (c2Bullish && c1SmallBody && c0Bearish && c0.close < (c2.open + c2.close) / 2) {
      return { name: 'Étoile du soir', description: 'Séquence de retournement baissier sur trois semaines — épuisement acheteur suivi d’un retour vendeur.' };
    }
    // Trois soldats blancs
    if (c2Bullish && (c1.close > c1.open) && c0Bullish
        && c1.close > c2.close && c0.close > c1.close) {
      return { name: 'Trois soldats blancs', description: 'Trois semaines consécutives de hausse avec clôtures croissantes — tendance haussière soutenue.' };
    }
    // Trois corbeaux noirs
    if (c2Bearish && (c1.close < c1.open) && c0Bearish
        && c1.close < c2.close && c0.close < c1.close) {
      return { name: 'Trois corbeaux noirs', description: 'Trois semaines consécutives de baisse avec clôtures décroissantes — tendance baissière soutenue.' };
    }
  }

  return null; // aucun pattern reconnu
}

// Export pour usage en environnement Node (tests) ET navigateur (via <script>)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    excludeCurrentIncompleteWeek,
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateATR,
    detectCandlestickPattern,
  };
}
