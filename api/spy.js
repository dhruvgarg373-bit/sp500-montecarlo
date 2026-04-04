export default async function handler(req, res) {
  // We use standard Yahoo ranges: 6mo, 1y, 2y, 5y
  const { lookback = '5y' } = req.query; 

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=${lookback}`;
    const response = await fetch(url);
    const yData = await response.json();

    const result = yData.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;

    const prices = [];
    const dates = [];

    // Clean out nulls and build pure arrays
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null) {
        prices.push(closes[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().split('T')[0]);
      }
    }

    // Send back EXACTLY what Claude's math engine originally wanted
    return res.status(200).json({
      prices: prices,
      startPrice: prices[prices.length - 1],
      meta: {
        source: 'Yahoo Finance Market Data',
        sessionsReturned: prices.length,
        oldestDate: dates[0],
        newestDate: dates[dates.length - 1]
      }
    });

  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch from Yahoo Finance.' });
  }
}
