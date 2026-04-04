# S&P 500 Monte Carlo Simulator v3

Heston Stochastic Volatility + Merton Jump Diffusion with regime-aware calibration.

## What's new in v3
- Lookback horizon selector: 100 days / 1yr / 2yr / 5yr
- Live calibration (μ, σ, ν₀, θ, λ) derived from actual price series — nothing hardcoded
- Alpha Vantage `outputsize=full` — 20+ years of data, sliced server-side
- Backend returns normalised `{ prices, startPrice, meta }` — frontend never parses raw AV JSON
- CORS fix: proxy at `/api/spy` runs server-side on Vercel

## Deploy to Vercel

### 1. Install Node.js
Download LTS: https://nodejs.org

### 2. Install & run locally
```
npm install
npm run dev
```
Open http://localhost:5173 → press Demo to test instantly.

### 3. Push to GitHub
```
git init
git add .
git commit -m "Monte Carlo v3"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sp500-montecarlo.git
git push -u origin main
```

### 4. Deploy on Vercel
- Go to vercel.com → New Project → Import repo
- Framework: Vite (auto-detected)
- Deploy → live in ~60s

## API Key
Free Alpha Vantage key: https://www.alphavantage.co/support/#api-key
Free tier: 25 requests/day, 5/min. The app uses outputsize=full — one call per simulation run.

## Do I need a second API key? No.
Alpha Vantage full history covers 20+ years of SPY. All lookback windows (100d/1yr/2yr/5yr)
are served from the same single endpoint, sliced server-side. No Tiingo needed.

## Portfolio talking points
- "I chose lookback window as a first-class parameter because calibration period is itself
  a model assumption — a 100-day window reflects the current vol regime, a 5-year window
  reflects structural drift. Showing how this changes output distribution demonstrates
  parameter sensitivity, which is core to any stochastic model in practice."
- "The Heston initial variance ν₀ auto-calibrates to σ² from the chosen window, not hardcoded.
  This means the model is always internally consistent."
- "Excess kurtosis in the output distribution proves the Merton jumps are doing real work —
  you can see the tails extend beyond the normal fit on the histogram."
