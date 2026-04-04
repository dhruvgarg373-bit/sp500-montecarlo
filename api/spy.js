export default async function handler(req, res) {
  const { apikey, lookback = '100d' } = req.query;

  try {
    // ─── 5-YEAR STRUCTURAL TREND (Yahoo Finance - No Key Required) ───
    if (lookback === '5y') {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5y';
      const response = await fetch(url);
      const yData = await response.json();

      const result = yData.chart.result[0];
      const timestamps = result.timestamp;
      const closes = result.indicators.quote[0].close;

      // Transform Yahoo data to perfectly match Alpha Vantage structure
      const timeSeries = {};
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] !== null) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          timeSeries[dateStr] = { '4. close': closes[i].toString() };
        }
      }
      return res.status(200).json({ 'Time Series (Daily)': timeSeries });
    } 
    
    // ─── 100-DAY CURRENT REGIME (Alpha Vantage - Requires Key) ───
    else {
      if (!apikey) return res.status(400).json({ error: 'API key is missing for 100-day data.' });
      
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=SPY&apikey=${apikey}`;
      const response = await fetch(url);
      const data = await response.json();

      // Catch API limits and errors directly
      if (data.Information) return res.status(429).json({ error: data.Information });
      if (data.Note) return res.status(429).json({ error: data.Note });
      if (data['Error Message']) return res.status(400).json({ error: data['Error Message'] });
      if (!data['Time Series (Daily)']) return res.status(500).json({ error: 'Unexpected JSON format from Alpha Vantage.' });

      return res.status(200).json(data);
    }
  } catch (error) {
    return res.status(500).json({ error: 'Serverless function failed to fetch.' });
  }
}
