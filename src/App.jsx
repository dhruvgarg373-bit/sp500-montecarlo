import { useState, useRef, useEffect } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Institutional Aesthetic Palette ─────────────────────────────────────────
const BG         = '#f5f2eb'; // Warm Cream
const CARD_BG    = '#fdfcfb'; // Block White
const SAGE       = '#7e998a'; // Primary Sage
const TEAL       = '#2a5c5d'; // Deep Teal
const MAHOGANY   = '#5c3a21'; // Mahogany Accent
const TEXT_MAIN  = '#2c363f'; 
const BORDER     = '#d4cec4';

export default function App() {
  const [ticker, setTicker] = useState('SPY');
  const [driftMode, setDriftMode] = useState('blended'); // historical, riskFree, blended
  const [forecastDays, setForecastDays] = useState(252);
  const [numSims, setNumSims] = useState(400);
  const [status, setStatus] = useState('idle');
  const [stats, setStats] = useState(null);
  const [histData, setHistData] = useState([]);
  const [calibration, setCalibration] = useState(null);
  
  const canvasRef = useRef(null);
  const pathsRef = useRef([]);

  async function handleRun() {
    setStatus('computing');
    try {
      const res = await fetch(`/api/spy?ticker=${ticker}&lookback=5y`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // --- QUANT CALIBRATION ENGINE ---
      const prices = data.prices;
      const logRet = [];
      for(let i=1; i<prices.length; i++) logRet.push(Math.log(prices[i]/prices[i-1]));
      
      const histMu = (logRet.reduce((a,b)=>a+b,0)/logRet.length) * 252;
      const histVar = (logRet.reduce((a,b)=>a+(b-(histMu/252))**2,0)/(logRet.length-1)) * 252;
      const rf = data.riskFreeRate;

      // Drift Methodology (Bayesian Shrinkage)
      let finalMu = histMu;
      if (driftMode === 'riskFree') finalMu = rf;
      if (driftMode === 'blended') finalMu = (histMu * 0.5) + (rf * 0.5);

      // GARCH / EWMA Initialization (λ = 0.94)
      let currentVar = logRet[0]**2;
      for(let i=1; i<logRet.length; i++) {
        currentVar = 0.06 * (logRet[i]**2) + 0.94 * currentVar;
      }
      const nu0 = currentVar * 252; // Annualized start variance

      setCalibration({ ticker: data.ticker, mu: finalMu, sigma: Math.sqrt(histVar), rf });

      const paths = runAllPaths({ 
        mu: finalMu, sigma0: Math.sqrt(nu0), nu0, theta: histVar, 
        kappa: 4, xi: 0.35, rho: -0.7, jumpLambda: 5, jumpMu: -0.02, jumpSigma: 0.05,
        startPrice: data.startPrice, forecastDays, numSims, model: 'full' 
      });
      pathsRef.current = paths;
      
      const finals = paths.map(p => p[p.length - 1]);
      setStats(computeStats(finals, data.startPrice));
      setHistData(buildHistogram(finals, data.startPrice));
      setStatus('done');
    } catch (e) { setStatus('idle'); }
  }

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '40px', color: TEXT_MAIN, fontFamily: 'serif' }}>
      <style>{`
        .block { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 12px; padding: 25px; box-shadow: 0 4px 25px rgba(0,0,0,0.03); }
        .main-btn { background: ${TEAL}; color: white; border: none; padding: 15px 40px; border-radius: 8px; font-weight: 800; cursor: pointer; transition: 0.3s; }
        .main-btn:hover { background: ${MAHOGANY}; transform: translateY(-2px); }
        .input-group { display: flex; flex-direction: column; gap: 8px; }
        label { font-size: 11px; font-weight: 900; text-transform: uppercase; color: ${SAGE}; letter-spacing: 1.5px; }
        h1 { color: ${TEAL}; font-size: 42px; font-weight: 900; line-height: 1.2; margin-bottom: 40px; border-bottom: 3px solid ${MAHOGANY}; display: inline-block; padding-bottom: 5px; }
        input, select { padding: 12px; border: 1px solid ${BORDER}; border-radius: 6px; font-family: sans-serif; }
      `}</style>

      <h1>Risk Simulation Engine</h1>

      <div className="block" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '30px', marginBottom: '40px' }}>
        <div className="input-group"><label>Asset Ticker</label><input value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())} /></div>
        <div className="input-group">
          <label>Drift Anchor</label>
          <select value={driftMode} onChange={e=>setDriftMode(e.target.value)}>
            <option value="historical">Historical (Pure Momentum)</option>
            <option value="riskFree">Risk-Neutral (Yield Anchor)</option>
            <option value="blended">Blended (Bayesian Shrinkage)</option>
          </select>
        </div>
        <div className="input-group"><label>Forecast (Days)</label><input type="range" min="21" max="504" value={forecastDays} onChange={e=>setForecastDays(+e.target.value)} /></div>
        <div style={{ alignSelf: 'end' }}><button className="main-btn" onClick={handleRun}>Run Simulation</button></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 400px', gap: '30px' }}>
        <div className="block">
          <label>Projected Trajectories</label>
          <canvas ref={canvasRef} width={1000} height={500} style={{ width: '100%', height: 'auto', marginTop: '20px' }} />
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
          <div className="block" style={{ borderLeft: `8px solid ${TEAL}` }}>
            <label>Expected Growth (μ)</label>
            <div style={{ fontSize: '38px', fontWeight: 900, color: TEAL }}>{stats ? stats.expectedReturn + '%' : '--'}</div>
            {calibration && <div style={{fontSize: '10px', color: SAGE, marginTop: 5}}>Risk-Free Rate: {(calibration.rf * 100).toFixed(2)}%</div>}
          </div>

          <div className="block" style={{ borderLeft: `8px solid ${MAHOGANY}` }}>
            <label>Tail Risk (VaR 95%)</label>
            <div style={{ fontSize: '28px', fontWeight: 900, color: MAHOGANY }}>{stats ? '-' + stats.varPct + '%' : '--'}</div>
            <p style={{ fontSize: '11px', marginTop: '12px', lineHeight: 1.5 }}>Maximum drawdown expected within a 95% confidence interval over the horizon.</p>
          </div>

          {calibration && (
            <div className="block" style={{ background: SAGE, color: 'white' }}>
              <label style={{color: 'white'}}>Calibration Metadata</label>
              <div style={{fontSize: '12px', marginTop: 10}}>{calibration.ticker} calibrated over {calibration.range}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
