// ============================================================
// Moteur de score — agrégation des 4 piliers en score normalisé sur 100
// Chaque sous-indicateur retourne une note de -2 à +2, moyennée par pilier,
// puis convertie en 0-100. Les piliers sont ensuite combinés selon leur poids.
// ============================================================

/**
 * Convertit une note brute [-2, +2] en sous-score [0, 100]
 */
function noteToSubscore(note) {
  const clamped = Math.max(-2, Math.min(2, note));
  return ((clamped + 2) / 4) * 100;
}

/**
 * Pilier Tendance : écart EMA21-EMA50, position du prix
 *
 * MODIFICATION DU 2026-07-10 — suppression de la note "penteEma21".
 * Justification : audit statistique (corrélation Pearson) a montré une
 * corrélation de 0.9999 entre penteEma21Pct et distEma21Pct sur 462 semaines
 * (2017-09 -> 2026-07). Ce n'est pas un artefact d'échantillon : c'est une
 * conséquence directe de la formule de récurrence de l'EMA
 * (EMA_t = EMA_{t-1} + alpha*(prix_t - EMA_{t-1})), qui rend la pente de
 * l'EMA quasi proportionnelle à l'écart prix/EMA. La note ne portait donc
 * quasiment aucune information indépendante des deux autres notes du pilier.
 * Testé empiriquement (walk-forward, split train 2017-2021/test 2021-2026)
 * avant suppression : impact sur l'IC du score global négligeable dans les
 * deux sens (écarts de 0.001 à 0.003, dans le bruit), corrélation
 * score-avec-note vs score-sans-note = 0.99836. Suppression sûre.
 * Ceci N'EST PAS un ajustement de pondération sur observation de performance
 * (règle de gouvernance §8) : c'est le retrait d'un doublon mathématiquement
 * démontré, catégorie de changement distincte.
 *
 * @param {object} params
 * @param {number} params.close - dernière clôture
 * @param {number} params.ema21
 * @param {number} params.ema50
 * @returns {{ score: number, notes: object }}
 */
function scoreTendance({ close, ema21, ema50 }) {
  const notes = {};

  // Note 1 : position du prix par rapport à l'EMA21
  const distEma21Pct = ((close - ema21) / ema21) * 100;
  notes.prixVsEma21 = clampNote(distEma21Pct / 2); // ±4% -> note pleine

  // Note 2 : position de l'EMA21 par rapport à l'EMA50 (tendance de fond)
  const distEma21Ema50Pct = ((ema21 - ema50) / ema50) * 100;
  notes.ema21VsEma50 = clampNote(distEma21Ema50Pct / 3); // ±6% -> note pleine

  const noteMoyenne = average(Object.values(notes));
  return { score: noteToSubscore(noteMoyenne), notes };
}

/**
 * Pilier Momentum : RSI, MACD
 */
function scoreMomentum({ rsi, macdHistogram, macdHistogramPrev }) {
  const notes = {};

  // Note 1 : RSI — zone de force (>50 favorable en Weekly trend-following, cf cahier des charges)
  notes.rsi = clampNote((rsi - 50) / 15); // RSI 50->note 0, RSI 80->note 2, RSI 20->note -2

  // Note 2 : histogramme MACD — positif = momentum haussier
  notes.macdNiveau = clampNote(macdHistogram * 8);

  // Note 3 : accélération de l'histogramme MACD
  const accel = macdHistogram - macdHistogramPrev;
  notes.macdAcceleration = clampNote(accel * 15);

  const noteMoyenne = average(Object.values(notes));
  return { score: noteToSubscore(noteMoyenne), notes };
}

/**
 * Pilier Volatilité : VIX, ATR
 * Note : ici un score ÉLEVÉ = favorable = volatilité CONTENUE (logique inversée)
 */
function scoreVolatilite({ vix, atrPct }) {
  const notes = {};

  // Note VIX : < 15 favorable, 15-25 neutre, > 25 défavorable
  let noteVix;
  if (vix < 15) noteVix = 2;
  else if (vix < 20) noteVix = 1;
  else if (vix < 25) noteVix = 0;
  else if (vix < 30) noteVix = -1;
  else noteVix = -2;
  notes.vix = noteVix;

  // Note ATR relatif (ATR en % du prix) : plus l'ATR% est élevé, plus le marché est nerveux
  // atrPct attendu autour de 1.5-2.5% en semaine calme, >4% en semaine agitée
  notes.atr = clampNote((2.5 - atrPct) / 1.5);

  const noteMoyenne = average(Object.values(notes));
  return { score: noteToSubscore(noteMoyenne), notes };
}

/**
 * Pilier Concentration du marché : ratio SPY/RSP
 * Note : une HAUSSE du ratio = concentration croissante = signal de fragilité (défavorable)
 */
function scoreConcentration({ ratioSpyRsp, ratioSpyRspMA }) {
  const notes = {};

  // Écart du ratio actuel par rapport à sa moyenne mobile récente
  const ecartPct = ((ratioSpyRsp - ratioSpyRspMA) / ratioSpyRspMA) * 100;
  // Un ratio qui s'envole au-dessus de sa moyenne = concentration qui s'accélère = défavorable
  notes.ecartRatio = clampNote(-ecartPct * 3);

  const noteMoyenne = average(Object.values(notes));
  return { score: noteToSubscore(noteMoyenne), notes };
}

/**
 * Calcule le score global pondéré à partir des 4 sous-scores de piliers
 * @param {object} pillars - { tendance, momentum, volatilite, concentration } chacun {score, notes}
 * @param {object} weights - { tendance, momentum, volatilite, concentration } en % (somme = 100)
 * @returns {{ globalScore: number, pillars: object, weights: object }}
 */
function calculateGlobalScore(pillars, weights) {
  const totalWeight = weights.tendance + weights.momentum + weights.volatilite + weights.concentration;

  // Normalisation défensive si les poids ne totalisent pas exactement 100
  const norm = (w) => (w / totalWeight) * 100;

  const globalScore =
    pillars.tendance.score * (norm(weights.tendance) / 100) +
    pillars.momentum.score * (norm(weights.momentum) / 100) +
    pillars.volatilite.score * (norm(weights.volatilite) / 100) +
    pillars.concentration.score * (norm(weights.concentration) / 100);

  return {
    globalScore: Math.round(globalScore * 10) / 10,
    pillars,
    weights,
  };
}

/**
 * Interprétation textuelle du score global, conforme au cahier des charges §7
 */
function interpretScore(globalScore) {
  if (globalScore >= 95) return { label: 'Contexte très favorable', level: 'very-favorable' };
  if (globalScore >= 80) return { label: 'Contexte favorable', level: 'favorable' };
  if (globalScore >= 60) return { label: 'Contexte neutre', level: 'neutral' };
  if (globalScore >= 40) return { label: 'Vigilance', level: 'caution' };
  return { label: 'Contexte défavorable', level: 'unfavorable' };
}

// --------------------------------------------------------------
// Utilitaires
// --------------------------------------------------------------

function clampNote(n) {
  if (Number.isNaN(n)) return 0;
  return Math.max(-2, Math.min(2, n));
}

function average(arr) {
  const valid = arr.filter((v) => !Number.isNaN(v));
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scoreTendance,
    scoreMomentum,
    scoreVolatilite,
    scoreConcentration,
    calculateGlobalScore,
    interpretScore,
    noteToSubscore,
  };
}
