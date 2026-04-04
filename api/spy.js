export default async function handler(req, res) {
  const { lookback = '1825', ticker = 'SPY' } = req.query; 

  // Map UI days to Yahoo ranges
  const rangeMap = { '100': '6mo', '365': '1y', '730': '2y', '1825': '5y', '5475': 'max' };
  const range = rangeMap[lookback] || '5y';

  try {
    const assetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}?interval=1d&range=${range}`;
    const assetRes = await fetch(assetUrl);
    const assetData = await assetRes.json();
    if (assetData.chart.error) return res.status(400).json({ error: `Ticker ${ticker} not found.` });

    const result = assetData.chart.result[0];
    const closes = result.indicators.quote[0].close;
    const timestamps = result.timestamp;

    const prices = [];
    const dates = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null) {
        prices.push(closes[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().split('T')[0]);
      }
    }

    let rf = 0.042; 
    try {
      const tnxRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/^TNX?interval=1d&range=5d`);
      const tnxData = await tnxRes.json();
      rf = (tnxData.chart.result[0].indicators.quote[0].close.slice(-1)[0] / 100);
    } catch (e) { console.warn("Treasury fetch failed."); }

    return res.status(200).json({
      ticker: ticker.toUpperCase(),
      prices,
      dates,
      startPrice: prices[prices.length - 1],
      riskFreeRate: rf,
      meta: { source: 'Yahoo Finance ^TNX / Equity' }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Data Fetch Failure' });
  }
}
