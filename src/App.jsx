import { useState, useRef, useEffect } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Theme Colors ────────────────────────────────────────────────────────────
const BG         = '#f5f2eb'; 
const CARD_BG    = '#fdfcfb'; 
const SAGE       = '#7e998a'; 
const TEAL       = '#2a5c5d'; 
const MAHOGANY   = '#5c3a21'; 
const TEXT_MAIN  = '#2c363f'; 
const BORDER     = '#d4cec4';

const LOOKBACK_OPTIONS = [
  { value: '100',  label: 'Current Regime (6M)', color: '#f97316' },
  { value: '365',  label: 'Medium Term (1Y)',    color: SAGE },
  { value: '730',  label: 'Post-Shock (2Y)',     color: TEAL },
  { value: '1825', label: 'Structural (5Y+)',    color: MAHOGANY },
];

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
  const [showAdv, setShowAdv] = useState(false);

  const canvasRef = useRef(null);
  const pathsRef = useRef([]);
  const rangeRef = useRef(null);
  const drawnRef = useRef(0);
  const animRef = useRef(null);

  // ─── Drawing Engine (Restored) ──────────────────────────────────────────────
  const PAD = { top: 24, right: 20, bottom: 44, left: 68 };
  function getScalers(range, days) {
    const W = 1000, H = 500;
    const iW = W - PAD.left - PAD.right, iH = H - PAD.top - PAD.bottom;
    const lMin = Math.log(range.min), lMax = Math.log(range.max);
    return {
      toX: d => PAD.left + (d / days) * iW,
      toY: p => {
        const frac = logScale ? (Math.log(p) - lMin) / (lMax - lMin) : (p - range.min) / (range.max - range.min);
        return PAD.top + (1 - frac) * iH;
      }
    };
  }

  function initCanvas(range) {
    const ctx = canvasRef.current.getContext('2d');
    const { toX, toY } = getScalers(range, forecastDays);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, 1000, 500);
    ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, 1000-PAD.left-PAD.right, 500-PAD.top-PAD.bottom);
    
    // Y-Axis labels
    ctx.textAlign = 'right'; ctx.fillStyle = TEXT_MAIN; ctx.font = '10px Inter';
    [0, 0.25, 0.5, 0.75, 1].forEach(f => {
        const p = range.min + f * (range.max - range.min);
        ctx.fillText(`$${Math.round(p)}`, PAD.left - 8, toY(p) + 4);
    });

    // Today Line
    ctx.setLineDash([5, 5]); ctx.strokeStyle = TEAL + '44';
    ctx.beginPath(); ctx.moveTo(PAD.left, toY(startPrice)); ctx.lineTo(1000-PAD.right, toY(startPrice)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ─── Simulation Core ───────────────────────────────────────────────────────
  async function handleRun() {
    setStatus('computing');
    try {
      const res = await fetch(`/api/spy?ticker=${ticker}&lookback=5y`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const logRet = [];
      for(let i=1; i<data.prices.length; i++) logRet.push(Math.log(data.prices[i]/data.prices[i-1]));
      const histMu = (logRet.reduce((a,b)=>a+b,0)/logRet.length) * 252;
      const histVar = (logRet.reduce((a,b)=>a+(b-(histMu/252))**2,0)/(logRet.length-1)) * 252;
      
      let finalMu = histMu;
      if (driftMode === 'riskFree') finalMu = data.riskFreeRate;
      if (driftMode === 'blended') finalMu = (histMu + data.riskFreeRate) / 2;

      // EWMA Volatility Initialization
      let currentVar = logRet[0]**2;
      for(let i=1; i<logRet.length; i++) currentVar = 0.06 * (logRet[i]**2) + 0.94 * currentVar;
      
      setStartPrice(data.startPrice);
      setCalibration({ ticker: data.ticker, mu: finalMu, sigma: Math.sqrt(histVar), rf: data.riskFreeRate });

      const paths = runAllPaths({ 
        mu: finalMu, sigma0: Math.sqrt(currentVar * 252), nu0: currentVar * 252, theta: histVar, 
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
  const pct = n => `${(n * 100).toFixed(2)}%`;

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '30px', color: TEXT_MAIN, fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .block { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); }
        .stat-val { font-size: 22px; font-weight: 900; color: ${TEAL}; }
        .stat-lbl { font-size: 10px; font-weight: 800; color: ${SAGE}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
        .main-btn { background: ${TEAL}; color: white; border: none; padding: 12px 30px; border-radius: 8px; font-weight: 800; cursor: pointer; transition: 0.2s; }
        .main-btn:hover { background: ${MAHOGANY}; }
        h1 { font-family: 'Syne', sans-serif; font-size: 36px; font-weight: 900; color: ${TEAL}; margin: 0; line-height: 1.1; padding-bottom: 10px; }
      `}</style>

      {/* Header & Stats Strip */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: `2px solid ${MAHOGANY}`, paddingBottom: '15px' }}>
          <h1>Risk Simulation Engine</h1>
          {stats && (
            <div style={{ display: 'flex', gap: '30px' }}>
              <div><div className="stat-lbl">Median</div><div className="stat-val">{fmt(stats.median)}</div></div>
              <div><div className="stat-lbl">Bull 95%</div><div className="stat-val" style={{color: SAGE}}>{fmt(stats.p95)}</div></div>
              <div><div className="stat-lbl">Bear 5%</div><div className="stat-val" style={{color: MAHOGANY}}>{fmt(stats.p5)}</div></div>
              <div><div className="stat-lbl">Exp. Return</div><div className="stat-val">{stats.expectedReturn}%</div></div>
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="block" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.5fr', gap: '20px', marginBottom: '20px' }}>
        <div><label className="stat-lbl">Ticker</label><input value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())} style={{width:'100%', padding:'10px', borderRadius:'6px', border:`1px solid ${BORDER}`}} /></div>
        <div>
          <label className="stat-lbl">Drift Anchor</label>
          <select value={driftMode} onChange={e=>setDriftMode(e.target.value)} style={{width:'100%', padding:'10px', borderRadius:'6px'}}>
            <option value="blended">Blended (Recommended)</option>
            <option value="historical">Historical Only</option>
            <option value="riskFree">Risk-Neutral (Yield)</option>
          </select>
        </div>
        <div><label className="stat-lbl">Forecast: {forecastDays} Days</label><input type="range" min="21" max="504" value={forecastDays} onChange={e=>setForecastDays(+e.target.value)} /></div>
        <div style={{ alignSelf: 'end', textAlign: 'right' }}><button className="main-btn" onClick={handleRun}>{status === 'idle' ? '▶ Calibrate & Run' : '● Simulating...'}</button></div>
      </div>

      {/* Main View */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
        <div className="block">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span className="stat-lbl">Monte Carlo Path Projections</span>
            {calibration && <span style={{fontSize:'10px', color:TEXT_MUTED}}>μ: {pct(calibration.mu)} | σ: {pct(calibration.sigma)} | RF: {pct(calibration.rf)}</span>}
          </div>
          <canvas ref={canvasRef} width={1000} height={500} style={{ width: '100%', height: 'auto' }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="block" style={{ height: '300px' }}>
            <span className="stat-lbl">Final Distribution</span>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={histData} margin={{top:10, right:0, left:-25, bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_C} vertical={false} />
                <XAxis dataKey="priceLabel" tick={{fontSize:10}} interval={Math.floor(histData.length/4)} />
                <YAxis tick={{fontSize:10}} />
                <Bar dataKey="count">{histData.map((d, i) => <Cell key={i} fill={d.above ? SAGE : MAHOGANY} />)}</Bar>
                <Line dataKey="normalPdf" stroke={TEAL} dot={false} strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {stats && (
            <div className="block" style={{ borderLeft: `6px solid ${MAHOGANY}` }}>
              <span className="stat-lbl" style={{color: MAHOGANY}}>Tail Risk Report</span>
              <div style={{marginTop:'10px'}}>
                <div style={{fontSize:'14px', fontWeight:800}}>VaR (95% Confidence): <span style={{color: MAHOGANY}}>-{stats.varPct}%</span></div>
                <div style={{fontSize:'11px', color:TEXT_MUTED, marginTop:'4px'}}>There is a 5% statistical probability of the price falling below {fmt(stats.p5)} within this horizon.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_PARAMS = { mu: 0.1, sigma0: 0.18, kappa: 4, theta: 0.0324, xi: 0.35, rho: -0.7, jumpLambda: 5, jumpMu: -0.02, jumpSigma: 0.05 };
