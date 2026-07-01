// ============================================================
// Proxy CORS pour récupération de données OHLC (Stooq + fallback Yahoo)
// Route : /api/prices?ticker=^spx&interval=w
// Déploiement : Cloudflare Pages Functions
//   -> placer ce fichier dans /functions/api/prices.js à la racine du projet Pages
// ============================================================

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const ticker = url.searchParams.get('ticker');       // ex: ^spx, spy.us, rsp.us, ^vix
  const interval = url.searchParams.get('interval') || 'w'; // w = hebdomadaire, d = journalier

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Requête préliminaire CORS (preflight)
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (!ticker) {
    return jsonResponse({ error: 'Paramètre "ticker" manquant' }, corsHeaders, 400);
  }

  // --- Tentative 1 : Stooq (source principale) ---
  try {
    const stooqUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker)}&i=${interval}`;
    const res = await fetch(stooqUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarketRegimeApp/1.0)' },
    });
    const text = await res.text();

    // Stooq renvoie parfois une page HTML d'erreur au lieu du CSV attendu
    if (res.ok && text && !text.trim().startsWith('<') && text.includes('Date')) {
      const data = parseStooqCsv(text);
      if (data.length > 0) {
        return jsonResponse({ source: 'stooq', ticker, interval, count: data.length, data }, corsHeaders);
      }
    }
    throw new Error(`Réponse Stooq invalide ou vide (statut ${res.status})`);
  } catch (errStooq) {
    // --- Tentative 2 : Yahoo Finance (fallback) ---
    try {
      const yahooTicker = mapTickerToYahoo(ticker);
      const yInterval = interval === 'w' ? '1wk' : '1d';
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?range=10y&interval=${yInterval}`;
      const res = await fetch(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MarketRegimeApp/1.0)',
          'Accept': 'application/json',
        },
      });
      const json = await res.json();
      const data = parseYahooChart(json);

      if (data.length > 0) {
        return jsonResponse({ source: 'yahoo', ticker, interval, count: data.length, data }, corsHeaders);
      }
      throw new Error('Réponse Yahoo invalide ou vide');
    } catch (errYahoo) {
      // Les deux sources ont échoué : on remonte le détail à l'UI pour diagnostic
      return jsonResponse({
        error: 'Échec de récupération des données (Stooq et Yahoo indisponibles)',
        details: {
          stooq: String(errStooq),
          yahoo: String(errYahoo),
        },
      }, corsHeaders, 502);
    }
  }
}

// --------------------------------------------------------------
// Fonctions utilitaires
// --------------------------------------------------------------

function jsonResponse(obj, corsHeaders, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Parse le CSV Stooq. Format attendu : Date,Open,High,Low,Close,Volume
function parseStooqCsv(text) {
  const lines = text.trim().split('\n');
  const rows = lines.slice(1); // on ignore la ligne d'en-tête
  return rows
    .map((line) => {
      const cols = line.split(',');
      if (cols.length < 5) return null;
      const [date, open, high, low, close, volume] = cols;
      if (!date || open === undefined) return null;
      return {
        date,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: volume ? parseFloat(volume) : null,
      };
    })
    .filter((row) => row && !Number.isNaN(row.close));
}

// Correspondance ticker Stooq -> ticker Yahoo (à compléter si d'autres tickers sont ajoutés)
function mapTickerToYahoo(stooqTicker) {
  const map = {
    '^spx': '^GSPC',
    'spy.us': 'SPY',
    'rsp.us': 'RSP',
    '^vix': '^VIX',
  };
  return map[stooqTicker.toLowerCase()] || stooqTicker.toUpperCase();
}

// Parse la réponse JSON de l'API chart Yahoo (v8/finance/chart)
function parseYahooChart(json) {
  try {
    const result = json.chart.result[0];
    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];
    return timestamps
      .map((t, i) => ({
        date: new Date(t * 1000).toISOString().split('T')[0],
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i],
        volume: quote.volume[i],
      }))
      .filter((row) => row.close !== null && row.close !== undefined);
  } catch (e) {
    return [];
  }
}
