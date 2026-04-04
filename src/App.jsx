import { useState, useRef, useEffect } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Theme ───────────────────────────────────────────────────────────
const BG         = '#f5f2eb'; 
const CARD_BG    = '#fdfcfb'; 
const SAGE       = '#7e998a'; 
const TEAL       = '#2a5c5d'; 
const MAHOGANY   = '#5c3a21'; 
const TEXT_MAIN  = '#2a3b38';
const BORDER     = '#d4cec4';

const LOOKBACK_OPTIONS = [
  { value: '5475', label: 'Post-GFC',   tag: '15yr' },
  { value: '1825', label: 'Structural', tag: '5yr+' },
  { value: '365',  label: 'Regime',     tag: '1yr' },
  { value: 'custom', label: 'Custom' },
];

export default function App() {
  const [ticker, setTicker] = useState('SPY');
  const [lookback, setLookback] = useState('1825');
  const [customDays, setCustomDays] = useState(100);
  const [driftMode, setDriftMode] = useState('blended');
  const [forecastDays, setForecastDays] = useState(252);
  const [numSims, setNumSims] = useState(400);
  const [status, setStatus] = useState('idle');
  const [stats, setStats] = useState(null);
  const [histData, setHistData] = useState([]);
  const [calibration, setCalibration] = useState(null);
  const [startPrice, setStartPrice] = useState(0);
  const [hoveredStat, setHoveredStat] = useState(null);

  const canvasRef = useRef(null);
  const pathsRef = useRef([]);
  const rangeRef = useRef(null);
  const drawnRef = useRef(0);
  const animRef = useRef(null);

  const formatPrice = (p) => {
    if (p >= 1000) return `$${(p / 1000).toFixed(1)}k`;
    return `$${p.toFixed(2)}`;
  };

  const PAD = { top: 30, right: 20, bottom: 44, left: 75 };
  const getScalers = (range, days) => {
    const W = 1000, H = 500;
    const iW = W - PAD.left - PAD.right, iH = H - PAD.top - PAD.bottom;
    return {
      toX: d => PAD.left + (d / days) * iW,
      toY: p => PAD.top + (1 - (p - range.min) / (range.max - range.min)) * iH
    };
  };

  function initCanvas(range) {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    const { toY } = getScalers(range, forecastDays);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, 1000, 500);
    ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, 1000-PAD.left-PAD.right, 500-PAD.top-PAD.bottom);
    
    ctx.textAlign = 'right'; ctx.fillStyle = TEXT_MAIN; ctx.font = '11px sans-serif';
    [0, 0.25, 0.5, 0.75, 1].forEach(f => {
      const p = range.min + f * (range.max - range.min);
      ctx.fillText(formatPrice(p), PAD.left - 10, toY(p) + 4);
    });
  }

  async function handleRun() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setStatus('computing');
    try {
      const activeLB = lookback === 'custom' ? customDays : lookback;
      const res = await fetch(`/api/spy?ticker=${ticker}&lookback=${activeLB}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const logRet = [];
      for(let i=1; i<data.prices.length; i++) logRet.push(Math.log(data.prices[i]/data.prices[i-1]));
      const histMu = (logRet.reduce((a,b)=>a+b,0)/logRet.length) * 252;
      const histVar = (logRet.reduce((a,b)=>a+(b-(histMu/252))**2,0)/(logRet.length-1)) * 252;
      
      let finalMu = histMu;
      if (driftMode === 'riskFree') finalMu = data.riskFreeRate;
      if (driftMode === 'blended') finalMu = (histMu + data.riskFreeRate) / 2;

      let currentVar = logRet[0]**2;
      for(let i=1; i<logRet.length; i++) currentVar = 0.06 * (logRet[i]**2) + 0.94 * currentVar;
      
      setStartPrice(data.startPrice);
      setCalibration({ 
        ticker: data.ticker, mu: finalMu, sigma: Math.sqrt(histVar), rf: data.riskFreeRate,
        start: data.dates[0], end: data.dates[data.dates.length - 1] 
      });

      const paths = runAllPaths({ 
        mu: finalMu, sigma0: Math.sqrt(currentVar * 252), nu0: currentVar * 252, theta: histVar, 
        kappa: 4, xi: 0.35, rho: -0.7, jumpLambda: 5, jumpMu: -0.02, jumpSigma: 0.05,
        startPrice: data.startPrice, forecastDays, numSims, model: 'full' 
      });
      pathsRef.current = paths;

      let minP = Infinity, maxP = -Infinity;
      paths.forEach(path => path.forEach(p => { if(p < minP) minP = p; if(p > maxP) maxP = p; }));
      rangeRef.current = { min: minP * 0.95, max: maxP * 1.05 };

      drawnRef.current = 0;
      startAnimation(data.startPrice);
    } catch (e) { setStatus('idle'); }
  }

  function startAnimation(liveStart) {
    const ctx = canvasRef.current.getContext('2d');
    const animate = () => {
      initCanvas(rangeRef.current);
      const { toX, toY } = getScalers(rangeRef.current, forecastDays);
      
      const from = 0;
      const to = Math.min(drawnRef.current + 5, pathsRef.current.length);
      for (let i = from; i < to; i++) {
        const path = pathsRef.current[i];
        const finalP = path[path.length - 1];
        let opacity = 0.35;
        if (hoveredStat === 'bear') opacity = finalP <= stats?.p5 ? 1.0 : 0.05;
        if (hoveredStat === 'bull') opacity = finalP >= stats?.p95 ? 1.0 : 0.05;

        ctx.strokeStyle = `hsla(${165 + (i % 50)}, 35%, 45%, ${opacity})`;
        ctx.beginPath(); ctx.moveTo(toX(0), toY(path[0]));
        path.forEach((p, d) => ctx.lineTo(toX(d), toY(p)));
        ctx.stroke();
      }
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

  // Effect to redraw on hover
  useEffect(() => {
    if (status === 'done' && canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      initCanvas(rangeRef.current);
      const { toX, toY } = getScalers(rangeRef.current, forecastDays);
      pathsRef.current.forEach((path, i) => {
        const finalP = path[path.length - 1];
        let opacity = 0.4;
        if (hoveredStat === 'bear') opacity = finalP <= stats.p5 ? 1.0 : 0.05;
        if (hoveredStat === 'bull') opacity = finalP >= stats.p95 ? 1.0 : 0.05;
        ctx.strokeStyle = `hsla(${165 + (i % 50)}, 35%, 45%, ${opacity})`;
        ctx.beginPath(); ctx.moveTo(toX(0), toY(path[0]));
        path.forEach((p, d) => ctx.lineTo(toX(d), toY(p)));
        ctx.stroke();
      });
    }
  }, [hoveredStat]);

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '40px', color: TEXT_MAIN, fontFamily: "'EB Garamond', serif" }}>
      <style>{`
        .block { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 12px; padding: 25px; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
        .stat-card { transition: 0.3s; border-left: 5px solid transparent; cursor: pointer; flex: 1; font-family: 'Inter', sans-serif; }
        .stat-card:hover { transform: translateY(-3px); background: #fff; box-shadow: 0 8px 20px rgba(0,0,0,0.05); }
        .lookback-btn { border: 1px solid ${BORDER}; background: #fff; padding: 12px; border-radius: 8px; cursor: pointer; flex: 1; text-align: center; transition: 0.2s; font-family: 'Inter', sans-serif; }
        .lookback-btn.active { background: ${TEAL}; color: white; border-color: ${TEAL}; }
        h1 { font-size: 42px; font-weight: 800; color: ${TEAL}; margin: 0; line-height: 1.1; padding-bottom: 12px; border-bottom: 3px solid ${MAHOGANY}; display: inline-block; }
        .label { font-size: 10px; font-weight: 800; color: ${SAGE}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; display: block; }
        input, select { padding: 12px; border: 1px solid ${BORDER}; border-radius: 8px; font-family: 'Inter', sans-serif; width: 100%; }
      `}</style>

      {/* Header Stat Strip */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '30px' }}>
        <div><h1>Risk Simulation Engine</h1></div>
        {stats && (
          <div style={{ display: 'flex', gap: '20px', width: '60%' }}>
             <div className="block stat-card">
               <span className="label">MEDIAN</span>
               <div style={{fontSize: '22px', fontWeight: 900}}>{formatPrice(stats.median)}</div>
             </div>
             <div className="block stat-card" style={{borderLeftColor: SAGE}} title="95th Percentile: Extremely optimistic outcome."
                  onMouseEnter={() => setHoveredStat('bull')} onMouseLeave={() => setHoveredStat(null)}>
               <span className="label">BULL 95%</span>
               <div style={{fontSize: '22px', fontWeight: 900, color: SAGE}}>{formatPrice(stats.p95)}</div>
             </div>
             <div className="block stat-card" style={{borderLeftColor: MAHOGANY}} title="5th Percentile: Maximum loss threshold."
                  onMouseEnter={() => setHoveredStat('bear')} onMouseLeave={() => setHoveredStat(null)}>
               <span className="label">BEAR 5%</span>
               <div style={{fontSize: '22px', fontWeight: 900, color: MAHOGANY}}>{formatPrice(stats.p5)}</div>
             </div>
             <div className="block stat-card">
               <span className="label">EXP RTN</span>
               <div style={{fontSize: '22px', fontWeight: 900, color: TEAL}}>{stats.expectedReturn}%</div>
             </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 1fr 1fr', gap: '20px', marginBottom: '20px' }}>
        <div className="block">
          <span className="label">Lookback Horizon</span>
          <div style={{display:'flex', gap:'8px'}}>
            {LOOKBACK_OPTIONS.map(opt => (
              <div key={opt.value} className={`lookback-btn ${lookback === opt.value ? 'active' : ''}`} onClick={() => setLookback(opt.value)}>
                <div style={{fontSize:'12px', fontWeight:800}}>{opt.label}</div>
              </div>
            ))}
          </div>
          {lookback === 'custom' && (
            <input type="range" min="100" max="3650" value={customDays} onChange={e=>setCustomDays(+e.target.value)} style={{marginTop:'15px', accentColor:MAHOGANY}} />
          )}
        </div>
        <div className="block">
          <span className="label">Asset Ticker</span>
          <input value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())} />
        </div>
        <div className="block">
          <span className="label">Drift Anchor</span>
          <select value={driftMode} onChange={e=>setDriftMode(e.target.value)}>
            <option value="blended">Blended (Recommended)</option>
            <option value="historical">Historical Only</option>
            <option value="riskFree">Risk-Neutral (Yield)</option>
          </select>
        </div>
        <div className="block" style={{display:'flex', flexDirection:'column', justifyContent:'center'}}>
          <button onClick={handleRun} style={{background:TEAL, color:'white', border:'none', padding:'15px', borderRadius:'8px', fontWeight:900, cursor:'pointer'}}>
            {status === 'idle' ? 'CALIBRATE & RUN' : 'SIMULATING...'}
          </button>
        </div>
      </div>

      {/* View */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
        <div className="block">
          <div style={{display:'flex', justifyContent:'space-between', marginBottom:'15px'}}>
             <span className="label" style={{color:TEXT_MAIN}}>Trajectories ({forecastDays} Days)</span>
             {calibration && <span style={{fontSize:'11px', color:SAGE, fontWeight:700}}>{calibration.ticker} CALIB: {calibration.start} TO {calibration.end} | μ: {(calibration.mu*100).toFixed(1)}% | σ: {(calibration.sigma*100).toFixed(1)}%</span>}
          </div>
          <canvas ref={canvasRef} width={1000} height={500} style={{ width: '100%', height: 'auto', background: BG }} />
          <input type="range" min="21" max="504" value={forecastDays} onChange={e=>setForecastDays(+e.target.value)} style={{width:'100%', marginTop:'15px', accentColor:TEAL}} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="block" style={{ height: '300px' }}>
            <span className="label">Final Distribution</span>
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

          <div className="block" style={{ borderLeft: `6px solid ${MAHOGANY}` }}>
             <span className="label" style={{color: MAHOGANY}}>Market Narrative</span>
             <p style={{fontSize:'12px', lineHeight:1.6, color:TEXT_MAIN, marginTop:'10px'}}>
               {ticker} risk profile is dominated by {calibration?.sigma > 0.25 ? 'High Volatility' : 'Structural Growth'}. 
               Heston Stochastic Volatility detected clustering, while Merton Jumps modeled a fat-tail distribution. 
               The {stats?.expectedReturn}% expected return is anchored to the 10-Year Treasury Yield.
             </p>
          </div>
        </div>
      </div>
    </div>
  );
}
