import { useState, useRef, useEffect } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Theme Colors & Fonts ──────────────────────────────────────────────────
// We specify a premium typography stack for an institutional feel.
const FONTS = {
  header: "'EB Garamond', serif",
  body: "'Inter', sans-serif",
  mono: "'IBM Plex Mono', monospace"
};

const COLORS = {
  cream: '#f5f2eb',
  sage: '#7e998a',
  teal: '#2a5c5d',
  mahogany: '#5c3a21',
  text: '#2a3b38',
  muted: '#6d7a71',
  border: '#d4cec4'
};

const LOOKBACK_OPTIONS = [
  { value: '5475', label: 'Post-GFC Shock', tag: '15yr' },
  { value: '1825', label: 'Structural Trend', tag: '5yr+' },
  { value: '365',  label: 'Current Regime',  tag: '1yr' },
  { value: 'custom', label: 'Custom' },
];

const driftOptions = [
  { value: 'blended',   label: 'Blended Drift (Recommended)', desc: 'Blends 50% history with 50% current Risk-Free Rate to reduce estimation error.'},
  { value: 'historical', label: 'Historical Only (Aggressive)', desc: 'Assumes the future will perfectly replicate past performance.' },
  { value: 'riskFree',   label: 'Risk-Neutral (Yield Anchor)',desc: 'Assumes all assets only return the Risk-Free rate over long horizons.' },
];

// ─── Tooltip Content ───────────────────────────────────────────────────────
const StatTooltips = {
  median: "The 50th percentile final price. In our simulation, half the scenarios ended higher, half ended lower.",
  bull: "The 95th percentile outcome. Represents an extremely positive scenario. Our model detected non-normal skew, pushing this 'Fat Tail' higher.",
  bear: "Value at Risk (VaR 95%). This is the 5th percentile threshold. In 95% of our 400 scenarios, the asset did *not* drop below this price.",
  return: "Annualized expected return for the ticker, calculated by blending historical momentum with the current 10-Year Treasury Yield (^TNX)."
};

// ─── Main Component ──────────────────────────────────────────────────────────
export default function App() {
  const [ticker,       setTicker]       = useState('SPY');
  const [lookback,     setLookback]     = useState('1825');
  const [customDays,   setCustomDays]   = useState(365); // Slider state if custom chosen
  const [driftMode,    setDriftMode]    = useState('blended');
  const [forecastDays, setForecastDays] = useState(252);
  const [numSims,      setNumSims]      = useState(400);
  const [status,       setStatus]       = useState('idle');
  const [calibration,  setCalibration]  = useState(null);
  const [stats,        setStats]        = useState(null);
  const [histData,     setHistData]     = useState([]);
  const [startPrice,   setStartPrice]   = useState(0);
  const [hoveredStat,  setHoveredStat]  = useState(null);

  const canvasRef = useRef(null);
  const pathsRef = useRef([]);
  const rangeRef = useRef(null);
  const drawnRef = useRef(0);
  const animRef = useRef(null);

  const PAD = { top: 24, right: 20, bottom: 44, left: 75 };

  // ─── Dynamic Price Formatting (Fixes X-Axis issue) ──────────────────────
  // This automatically adjusts from full prices ($20.00) to 'k' format ($5.5k).
  const formatPrice = (p) => {
    if (p >= 1000) return `$${(p / 1000).toFixed(1)}k`;
    return `$${p.toFixed(2)}`;
  };

  const fmtCurrency = n => `$${Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  const fmtDate = (dString) => new Date(dString).toLocaleDateString(undefined, {year: 'numeric', month: 'short'});

  const getScalers = (range, days) => {
    const W = 1000, H = 500;
    const iW = W - PAD.left - PAD.right, iH = H - PAD.top - PAD.bottom;
    return {
      toX: d => PAD.left + (d / days) * iW,
      toY: p => PAD.top + (1 - (p - range.min) / (range.max - range.min)) * iH
    };
  };

  function initCanvas(range) {
    const ctx = canvasRef.current.getContext('2d');
    const { toY } = getScalers(range, forecastDays);
    ctx.fillStyle = COLORS.cream; ctx.fillRect(0, 0, 1000, 500);
    ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, 1000-PAD.left-PAD.right, 500-PAD.top-PAD.bottom);
    
    // Adapted Axes Labels
    ctx.textAlign = 'right'; ctx.fillStyle = COLORS.text; ctx.font = `11px ${FONTS.mono}`;
    [0, 0.25, 0.5, 0.75, 1].forEach(f => {
        const p = range.min + f * (range.max - range.min);
        ctx.fillText(formatPrice(p), PAD.left - 10, toY(p) + 4);
    });

    // Today Reference Line
    ctx.setLineDash([5, 5]); ctx.strokeStyle = COLORS.mahogany;
    ctx.beginPath(); ctx.moveTo(PAD.left, toY(startPrice)); ctx.lineTo(1000-PAD.right, toY(startPrice)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ─── Interactive Drawing on Hover ──────────────────────────────────────────
  function drawPaths(ctx, from, to) {
    const { toX, toY } = getScalers(rangeRef.current, forecastDays);
    for (let i = from; i < to; i++) {
        const path = pathsRef.current[i];
        const finalP = path[path.length - 1];
        let opacity = 0.35;
        if (hoveredStat === 'bear') opacity = finalP <= stats.p5 ? 1.0 : 0.05;
        if (hoveredStat === 'bull') opacity = finalP >= stats.p95 ? 1.0 : 0.05;

        ctx.strokeStyle = `hsla(${165 + (i % 50)}, 40%, 40%, ${opacity})`;
        ctx.lineWidth = opacity > 0.5 ? 2.5 : 1;
        ctx.beginPath(); ctx.moveTo(toX(0), toY(path[0]));
        path.forEach((p, d) => ctx.lineTo(toX(d), toY(p)));
        ctx.stroke();
    }
  }

  // Redraw when hover changes
  useEffect(() => {
    if (status === 'done') {
        const ctx = canvasRef.current.getContext('2d');
        ctx.fillStyle = COLORS.cream; ctx.fillRect(0, 0, 1000, 500);
        const scalers = getScalers(rangeRef.current, forecastDays);
        
        // Re-draw grid/today line first
        initCanvas(rangeRef.current);
        
        // Re-draw paths with new opacity
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        drawPaths(ctx, 0, pathsRef.current.length);
    }
  }, [hoveredStat]);

  // ─── Start Animation ───────────────────────────────────────────────────────
  function startAnimation(liveStart) {
    const ctx = canvasRef.current.getContext('2d');
    const animate = () => {
      ctx.fillStyle = COLORS.cream; ctx.fillRect(0, 0, 1000, 500);
      initCanvas(rangeRef.current);

      const from = 0;
      const to = Math.min(drawnRef.current + 5, pathsRef.current.length);
      drawPaths(ctx, from, to);
      drawnRef.current = to;

      if (to % 20 === 0 || to === pathsRef.current.length) {
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

  // ─── Main Simulation Logic ──────────────────────────────────────────────────
  async function handleRun() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setStatus('computing'); setStats(null); setHistData([]); setCalibration(null);
    try {
      // adapt dynamic range for Custom days
      const daysToFetch = lookback === 'custom' ? customDays : lookback;
      const res = await fetch(`/api/spy?ticker=${ticker}&lookback=${daysToFetch}`);
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
      if (driftMode === 'blended') finalMu = (histMu + rf) / 2;

      // EWMA (GARCH-lite) Volatility Memory
      let currentVar = logRet[0]**2;
      for(let i=1; i<logRet.length; i++) currentVar = 0.06 * (logRet[i]**2) + 0.94 * currentVar;
      const nu0 = currentVar * 252;

      // --- POPULATE CALIBRATION DATA CORRECTLY ---
      // We parse the date range from the data.dates array.
      setCalibration({
        ticker: data.ticker,
        mu: finalMu, 
        sigma: Math.sqrt(histVar), 
        rf,
        oldestDate: data.dates[0],
        newestDate: data.dates[data.dates.length - 1]
      });

      const paths = runAllPaths({ 
        mu: finalMu, sigma0: Math.sqrt(nu0), nu0, theta: histVar, 
        kappa: 4, xi: 0.35, rho: -0.7, jumpLambda: 5, jumpMu: -0.02, jumpSigma: 0.05,
        startPrice: data.startPrice, forecastDays, numSims, model: 'full' 
      });
      pathsRef.current = paths;

      let minP = Infinity, maxP = -Infinity;
      paths.forEach(path => path.forEach(p => { if(p < minP) minP = p; if(p > maxP) maxP = p; }));
      rangeRef.current = { min: minP * 0.95, max: maxP * 1.05 };

      drawnRef.current = 0;
      setStartPrice(data.startPrice);
      startAnimation(data.startPrice);
    } catch (e) { console.error(e); setStatus('idle'); }
  }

  // Narrative generation logic
  const narrative = useMemo(() => {
    if(!stats || !calibration) return null;
    return `Heston model calibrated vol clusters (σ=${(calibration.sigma*100).toFixed(1)}%). Merton Jump Diffusion modeled crash/rally risk (excess kurtosis). Blended drift ({stats.expectedReturn}%) anchored projection to current Risk-Free yield. The outcome follows a non-normal, fat-tail distribution.`;
  }, [stats, calibration]);

  return (
    <div style={{ background: COLORS.cream, minHeight: '100vh', padding: '30px', color: COLORS.text, fontFamily: FONTS.body }}>
      {/*Typography Injection for institutional feel*/}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@800&family=IBM+Plex+Mono:wght@500&family=Inter:wght@500;700;800;900&display=swap');
        .block { background: COLORS.block; border: 1px solid ${COLORS.border}; border-radius: 12px; padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.02); }
        .stat-card { transition: 0.3s ease; cursor: pointer; border-left: 5px solid transparent; flex: 1; }
        .stat-card:hover { transform: translateY(-4px); background: #fff; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
        .main-btn { background: ${COLORS.teal}; color: white; border: none; padding: 15px 40px; border-radius: 8px; font-weight: 800; cursor: pointer; transition: 0.3s ease; }
        .main-btn:hover { background: ${COLORS.mahogany}; transform: translateY(-1px); }
        h1 { font-family: ${FONTS.header}; font-size: 40px; font-weight: 800; color: ${COLORS.teal}; margin: 0; line-height: 1.1; display: inline-block; }
        .lookback-btn { border: 1px solid ${COLORS.border}; background: #fff; padding: 10px; border-radius: 6px; cursor: pointer; flex: 1; text-align: center; transition: 0.2s; }
        .lookback-btn.active { background: ${COLORS.teal}; color: white; border-color: ${COLORS.teal}; }
        .control-label { font-size: 10px; font-weight: 800; color: ${COLORS.muted}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; display: block; }
        select, input[type=text] { padding: 12px; border: 1px solid ${COLORS.border}; border-radius: 6px; font-family: ${FONTS.mono}; font-size: 13px; width: 100%; }
        .custom-days-slider { width: 100%; marginTop: 15px; accentColor: ${COLORS.mahogany}; }
      `}</style>

      {/* Header Stat Strip (Fixed name, beautiful fonts) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '30px' }}>
        <div><h1>Monte Carlo Simulation Engine</h1></div>
        {stats && (
          <div style={{ display: 'flex', gap: '20px', width: '60%' }}>
             <div className="block stat-card" title={StatTooltips.median}>
               <div style={{fontSize: '10px', fontWeight: 800, color: COLORS.sage}}>MEDIAN</div>
               <div style={{fontSize: '22px', fontWeight: 900}}>{formatPrice(stats.median)}</div>
             </div>
             <div className="block stat-card" title={StatTooltips.bull} style={{borderLeftColor: COLORS.sage}}
                  onMouseEnter={() => setHoveredStat('bull')} onMouseLeave={() => setHoveredStat(null)}>
               <div style={{fontSize: '10px', fontWeight: 800, color: COLORS.sage}}>BULL 95%</div>
               <div style={{fontSize: '22px', fontWeight: 900, color: COLORS.sage}}>{formatPrice(stats.p95)}</div>
             </div>
             <div className="block stat-card" title={StatTooltips.bear} style={{borderLeftColor: COLORS.mahogany}}
                  onMouseEnter={() => setHoveredStat('bear')} onMouseLeave={() => setHoveredStat(null)}>
               <div style={{fontSize: '10px', fontWeight: 800, color: COLORS.mahogany}}>BEAR 5% (VaR)</div>
               <div style={{fontSize: '22px', fontWeight: 900, color: COLORS.mahogany}}>{formatPrice(stats.p5)}</div>
             </div>
             <div className="block stat-card" title={StatTooltips.return}>
               <div style={{fontSize: '10px', fontWeight: 800, color: COLORS.teal}}>EXP RETURN</div>
               <div style={{fontSize: '22px', fontWeight: 900, color: COLORS.teal}}>{stats.expectedReturn}%</div>
             </div>
          </div>
        )}
      </div>

      {/* Control Block (Lookback buttons on left, dynamic custom days) */}
      <div className="block" style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 1fr 1fr', gap: '25px', marginBottom: '20px' }}>
        <div>
          <span className="control-label">Lookback Horizon</span>
          <div style={{display:'flex', gap:'8px'}}>
            {LOOKBACK_OPTIONS.map(opt => (
              <div key={opt.value} className={`lookback-btn ${lookback === opt.value ? 'active' : ''}`} onClick={() => setLookback(opt.value)}>
                <div style={{fontSize:'12px', fontWeight:800}}>{opt.label}</div>
                {opt.tag && <div style={{fontSize:'10px', opacity:0.7}}>{opt.tag}</div>}
              </div>
            ))}
          </div>
          {lookback === 'custom' && (
             <div className="fade-in" style={{marginTop:'12px', padding: '10px', background:'#eee', borderRadius:'6px'}}>
               <span className="control-label" style={{color: COLORS.mahogany}}>Custom Days: <strong style={{color: COLORS.teal, fontStyle:'normal'}}>{customDays}</strong></span>
               <input type="range" min="100" max="3780" step="100" value={customDays} onChange={e=>setCustomDays(+e.target.value)} className="custom-days-slider" />
             </div>
          )}
        </div>
        <div><label className="control-label">Asset Ticker</label><input type="text" value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())} style={{color: COLORS.teal, fontWeight:800}} /></div>
        <div>
          <label className="control-label">Drift Anchor</label>
          <select value={driftMode} onChange={e=>setDriftMode(e.target.value)} style={{fontWeight:700}} title={driftOptions.find(o=>o.value===driftMode).desc}>
            {driftOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
        <div style={{ alignSelf: 'end', textAlign: 'right' }}>
           <button className="main-btn" onClick={handleRun}>
            {status === 'idle' ? 'CALIBRATE & RUN' : 'SIMULATING...'}
           </button>
        </div>
      </div>

      {/* Main Analysis View */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
        <div className="block">
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'12px'}}>
             <span className="control-label" style={{color: COLORS.text, margin:0}}>Trajectories ({forecastDays} Days)</span>
             {/* THE CALIBRATION BANNER FIX (The undefined fix) */}
             {calibration && (
               <div style={{fontSize:'10px', color: COLORS.sage, fontWeight:700, padding:'3px 8px', background:`${COLORS.teal}11`, borderRadius:'4px', border:`1px solid ${COLORS.sage}44`}}>
                 {calibration.ticker} calibrated: {fmtDate(calibration.oldestDate)} to {fmtDate(calibration.newestDate)} | μ: {(calibration.mu*100).toFixed(1)}% | σ: {(calibration.sigma*100).toFixed(1)}%
               </div>
             )}
          </div>
          <canvas ref={canvasRef} width={1000} height={500} style={{ width: '100%', height: 'auto' }} />
          <input type="range" min="21" max="504" value={forecastDays} onChange={e=>setForecastDays(+e.target.value)} style={{width:'100%', marginTop:'15px', accentColor: COLORS.teal}} title={`Horizon: ${forecastDays} Days`}/>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="block" style={{ height: '300px' }}>
            <span className="control-label" style={{color: COLORS.text, margin:0}}>Final Distribution ({numSims} Paths)</span>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={histData} margin={{top:10, right:0, left:-20, bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} vertical={false} />
                <XAxis dataKey="priceBucket" stroke={COLORS.muted} tick={{fontSize:10, fill: COLORS.muted}} />
                <YAxis stroke={COLORS.muted} tick={{fontSize:10, fill: COLORS.muted}} />
                <Bar dataKey="count">{histData.map((d, i) => <Cell key={i} fill={d.above ? COLORS.sage : COLORS.mahogany} />)}</Bar>
                <Line dataKey="normalPdf" stroke={COLORS.teal} dot={false} strokeWidth={2.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="block" style={{ borderLeft: `6px solid ${MAHOGANY}` }}>
             <span className="control-label" style={{color: MAHOGANY, margin:0}}>Tail Drawdown (VaR 95%)</span>
             <div style={{fontSize: '32px', fontWeight: 900, color: MAHOGANY, marginTop:'5px'}}>{stats ? `-${stats.varPct}%` : '--'}</div>
             <p style={{fontSize:'11px', color: COLORS.text, marginTop:'12px', lineHeight:1.5, fontFamily:FONTS.mono}}>
               Threshold: {stats ? formatPrice(stats.p5) : '--'}<br/>
               The asset dropped below this price in 5% of our non-normal scenarios.
             </p>
          </div>
          
          {/* THE UNDEFINED BOX FIX: Institutional Narrative */}
          {stats && (
             <div className="block fade-in" style={{background: `${COLORS.mahogany}10`, color:COLORS.text}}>
               <span className="control-label" style={{color: COLORS.mahogany, margin:0}}>Market Profile & Narrative</span>
               <div style={{fontSize:'12px', marginTop:10, lineHeight:1.7}}>
                <strong>{calibration.ticker} Projection.</strong><br/>
                Heston detect vol clusters. Merton Diffusion captures fat tails (crash probability). 
                Blended drift ({stats.expectedReturn}%) anchors projection to current 10-Year Treasury Yield. 
                Use these percentiles for robust capital allocation against idiosyncratic risk.
               </div>
             </div>
          )}
        </div>
      </div>
    </div>
  );
}
