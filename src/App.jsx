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
  const [driftMode, setDriftMode] = useState('blended'); 
  const [forecastDays, setForecastDays] = useState(252);
  const [numSims, setNumSims] = useState(400);
  const [logScale, setLogScale] = useState(false);
  const [status, setStatus] = useState('idle');
  const [stats, setStats] = useState(null);
  const [histData, setHistData] = useState([]);
  const [calibration, setCalibration] = useState(null);
  const [startPrice, setStartPrice] = useState(5540);
  
  const canvasRef = useRef(null);
  const pathsRef = useRef([]);
  const rangeRef = useRef(null);
  const drawnRef = useRef(0);
  const animRef = useRef(null);

  const PAD = { top: 24, right: 20, bottom: 44, left: 68 };

  // ─── Drawing Helpers ───────────────────────────────────────────────────────
  function getScalers(range, days) {
    const W = 1000, H = 500;
    const iW = W - PAD.left - PAD.right, iH = H - PAD.top - PAD.bottom;
    const lMin = Math.log(Math.max(range.min, 1)), lMax = Math.log(range.max);
    return {
      toX: d => PAD.left + (d / days) * iW,
      toY: p => {
        const val = Math.max(p, 0.1);
        const frac = logScale ? (Math.log(val) - lMin) / (lMax - lMin) : (p - range.min) / (range.max - range.min);
        return PAD.top + (1 - frac) * iH;
      }
    };
  }

  function initCanvas(range) {
    const ctx = canvasRef.current.getContext('2d');
    const { toY } = getScalers(range, forecastDays);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, 1000, 500);
    ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, 1000-PAD.left-PAD.right, 500-PAD.top-PAD.bottom);
    
    ctx.textAlign = 'right'; ctx.fillStyle = TEXT_MAIN; ctx.font = '10px sans-serif';
    [0, 0.25, 0.5, 0.75, 1].forEach(f => {
        const p = range.min + f * (range.max - range.min);
        ctx.fillText(`$${Math.round(p)}`, PAD.left - 8, toY(p) + 4);
    });

    ctx.setLineDash([5, 5]); ctx.strokeStyle = TEAL + '44';
    ctx.beginPath(); ctx.moveTo(PAD.left, toY(startPrice)); ctx.lineTo(1000-PAD.right, toY(startPrice)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ─── Simulation Logic ──────────────────────────────────────────────────────
  async function handleRun() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setStatus('computing');
    try {
      const res = await fetch(`/api/spy?ticker=${ticker}&lookback=5y`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const prices = data.prices;
      const logRet = [];
      for(let i=1; i<prices.length; i++) logRet.push(Math.log(prices[i]/prices[i-1]));
      
      const histMu = (logRet.reduce((a,b)=>a+b,0)/logRet.length) * 252;
      const histVar = (logRet.reduce((a,b)=>a+(b-(histMu/252))**2,0)/(logRet.length-1)) * 252;
      const rf = data.riskFreeRate;

      let finalMu = histMu;
      if (driftMode === 'riskFree') finalMu = rf;
      if (driftMode === 'blended') finalMu = (histMu * 0.5) + (rf * 0.5);

      // EWMA (GARCH-lite) Volatility Memory
      let currentVar = logRet[0]**2;
      for(let i=1; i<logRet.length; i++) {
        currentVar = 0.06 * (logRet[i]**2) + 0.94 * currentVar;
      }
      const nu0 = currentVar * 252;

      setStartPrice(data.startPrice);
      setCalibration({ ticker: data.ticker, mu: finalMu, sigma: Math.sqrt(histVar), rf });

      const paths = runAllPaths({ 
        mu: finalMu, sigma0: Math.sqrt(nu0), nu0, theta: histVar, 
        kappa: 4, xi: 0.35, rho: -0.7, jumpLambda: 5, jumpMu: -0.02, jumpSigma: 0.05,
        startPrice: data.startPrice, forecastDays, numSims, model: 'full' 
      });
      pathsRef.current = paths;

      let minP = Infinity, maxP = -Infinity;
      paths.forEach(path => path.forEach(p => { if(p < minP) minP = p; if(p > maxP) maxP = p; }));
      rangeRef.current = { min: minP * 0.9, max: maxP * 1.1 };

      initCanvas(rangeRef.current);
      drawnRef.current = 0;
      startAnimation(data.startPrice);
    } catch (e) { setStatus('idle'); }
  }

  function startAnimation(liveStart) {
    const ctx = canvasRef.current.getContext('2d');
    const { toX, toY } = getScalers(rangeRef.current, forecastDays);
    
    const animate = () => {
      const from = drawnRef.current, to = Math.min(from + 5, pathsRef.current.length);
      for (let i = from; i < to; i++) {
        ctx.strokeStyle = `hsla(${160 + (i % 40)}, 40%, 40%, 0.4)`;
        ctx.beginPath(); ctx.moveTo(toX(0), toY(pathsRef.current[i][0]));
        pathsRef.current[i].forEach((p, d) => ctx.lineTo(toX(d), toY(p)));
        ctx.stroke();
      }
      drawnRef.current = to;
      if (to % 25 === 0 || to === pathsRef.current.length) {
        const finals = pathsRef.current.slice(0, to).map(p => p[p.length - 1]);
        setHistData(buildHistogram(finals, liveStart));
        if(to === pathsRef.current.length) {
          setStats(computeStats(finals, liveStart));
          setStatus('done'); return;
        }
      }
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
  }

  const fmt = n => `$${Math.round(n).toLocaleString()}`;

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '40px', color: TEXT_MAIN, fontFamily: 'serif' }}>
      <style>{`
        .block { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 12px; padding: 25px; box-shadow: 0 4px 25px rgba(0,0,0,0.03); }
        .main-btn { background: ${TEAL}; color: white; border: none; padding: 15px 40px; border-radius: 8px; font-weight: 800; cursor: pointer; transition: 0.3s; }
        .main-btn:hover { background: ${MAHOGANY}; transform: translateY(-2px); }
        label { font-size: 11px; font-weight: 900; text-transform: uppercase; color: ${SAGE}; letter-spacing: 1.5px; margin-bottom: 8px; display: block; }
        h1 { color: ${TEAL}; font-size: 42px; font-weight: 900; line-height: 1.2; margin: 0 0 40px 0; border-bottom: 3px solid ${MAHOGANY}; display: inline-block; padding-bottom: 5px; }
        input, select { padding: 12px; border: 1px solid ${BORDER}; border-radius: 6px; font-family: sans-serif; width: 100%; }
      `}</style>

      <h1>Risk Simulation Engine</h1>

      <div className="block" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '30px', marginBottom: '40px' }}>
        <div><label>Asset Ticker</label><input value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())} /></div>
        <div>
          <label>Drift Anchor</label>
          <select value={driftMode} onChange={e=>setDriftMode(e.target.value)}>
            <option value="blended">Blended (Recommended)</option>
            <option value="historical">Historical (Pure Momentum)</option>
            <option value="riskFree">Risk-Neutral (Yield Anchor)</option>
          </select>
        </div>
        <div><label>Forecast: {forecastDays} Days</label><input type="range" min="21" max="504" value={forecastDays} onChange={e=>setForecastDays(+e.target.value)} /></div>
        <div style={{ alignSelf: 'end', textAlign: 'right' }}><button className="main-btn" onClick={handleRun}>Run Simulation</button></div>
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
            <p style={{ fontSize: '11px', marginTop: '12px', lineHeight: 1.5 }}>Maximum drawdown expected within a 95% confidence interval.</p>
          </div>

          <div className="block">
            <label>Final Distribution</label>
            <div style={{height: '200px'}}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={histData} margin={{top:10, right:0, left:-25, bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BORDER} vertical={false} />
                  <XAxis dataKey="priceLabel" tick={{fontSize:9}} interval={Math.floor(histData.length/4)} />
                  <YAxis tick={{fontSize:9}} />
                  <Bar dataKey="count">{histData.map((d, i) => <Cell key={i} fill={d.above ? SAGE : MAHOGANY} />)}</Bar>
                  <Line dataKey="normalPdf" stroke={TEAL} dot={false} strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
