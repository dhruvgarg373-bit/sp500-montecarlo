export default async function handler(req, res) {
  const { apikey } = req.query;

  // 1. Ensure an API key was actually passed from the frontend
  if (!apikey) {
    return res.status(400).json({ error: 'API key is missing.' });
  }

  try {
    // 2. Build the standard Alpha Vantage URL (Note: outputsize=full is removed for free tier)
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=SPY&apikey=${apikey}`;
    
    // 3. Fetch the data securely on the backend
    const response = await fetch(url);
    const data = await response.json();

    // 4. Catch Alpha Vantage API limits and warning messages directly
    if (data.Information) return res.status(429).json({ error: data.Information });
    if (data.Note) return res.status(429).json({ error: data.Note });
    if (data['Error Message']) return res.status(400).json({ error: data['Error Message'] });
    
    // 5. Ensure the core pricing data actually exists before sending it back
    if (!data['Time Series (Daily)']) {
      return res.status(500).json({ error: 'Unexpected JSON format from Alpha Vantage.' });
    }

    // 6. Send the successful data back to App.jsx
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Serverless function failed to fetch.' });
  }
}
