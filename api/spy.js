export default async function handler(req, res) {
  const { lookback = '1825', ticker = 'SPY' } = req.query; 

  // Map requested days to valid Yahoo Finance ranges
  const rangeMap = {
    '100': '6mo',
    '365': '1y',
    '1825': '5y',
    '5475': 'max', // 15 years -> 'max' is safest for oldest possible data
  };
  const range = rangeMap[lookback] || 'max';

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

    // Clean data and build pure arrays
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null) {
        prices.push(closes[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().split('T')[0]);
      }
    }

    // Slice to the EXACT number of days requested (since Yahoo 'max' is arbitrary)
    const numToKeep = Math.min(parseInt(lookback), prices.length);
    const slicedPrices = prices.slice(-numToKeep);
    const slicedDates = dates.slice(-numToKeep);

    // Fetch Risk-Free Rate (^TNX) from Yield Curve
    let rf = 0.042; 
    try {
      const tnxRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/^TNX?interval=1d&range=5d`);
      const tnxData = await tnxRes.json();
      rf = (tnxData.chart.result[0].indicators.quote[0].close.slice(-1)[0] / 100);
    } catch (e) { console.warn("Treasury fetch failed, using fallback."); }

    return res.status(200).json({
      ticker: ticker.toUpperCase(),
      prices: slicedPrices,
      dates: slicedDates,
      startPrice: slicedPrices[slicedPrices.length - 1],
      riskFreeRate: rf,
      meta: { source: 'Yahoo Finance' }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Data Fetch Failure' });
  }
}
