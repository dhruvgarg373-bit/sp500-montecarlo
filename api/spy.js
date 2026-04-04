export default async function handler(req, res) {
  // Now accepts a dynamic ticker, defaults to SPY if blank
  const { lookback = '5y', ticker = 'SPY' } = req.query; 

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}?interval=1d&range=${lookback}`;
    const response = await fetch(url);
    const yData = await response.json();

    if (yData.chart.error) {
      return res.status(400).json({ error: `Ticker ${ticker} not found or delisted.` });
    }

    const result = yData.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;

    const prices = [];
    const dates = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null) {
        prices.push(closes[i]);
        dates.push(new Date(timestamps[i] * 1000).toISOString().split('T')[0]);
      }
    }

    return res.status(200).json({
      ticker: ticker.toUpperCase(),
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
    return res.status(500).json({ error: 'Failed to fetch data. Check ticker symbol.' });
  }
}
