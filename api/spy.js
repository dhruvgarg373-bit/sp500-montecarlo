export default async function handler(req, res) {
  const { lookback = '5y', ticker = 'SPY' } = req.query; 

  try {
    // 1. Fetch Asset Data
    const assetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}?interval=1d&range=${lookback}`;
    const assetRes = await fetch(assetUrl);
    const assetData = await assetRes.json();
    if (assetData.chart.error) return res.status(400).json({ error: `Ticker ${ticker} not found.` });

    const closes = assetData.chart.result[0].indicators.quote[0].close;
    const prices = closes.filter(p => p !== null);

    // 2. Fetch Risk-Free Rate (^TNX) from Yield Curve
    let rf = 0.042; 
    try {
      const tnxRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/^TNX?interval=1d&range=5d`);
      const tnxData = await tnxRes.json();
      rf = (tnxData.chart.result[0].indicators.quote[0].close.slice(-1)[0] / 100);
    } catch (e) { console.warn("Treasury fetch failed, using fallback."); }

    return res.status(200).json({
      ticker: ticker.toUpperCase(),
      prices,
      startPrice: prices[prices.length - 1],
      riskFreeRate: rf,
      meta: { source: 'Yahoo Finance ^TNX / Equity' }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Data Fetch Failure' });
  }
}
