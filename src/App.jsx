import { useState, useRef, useEffect } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Theme Colors ────────────────────────────────────────────────────────────
const BG         = '#f5f2eb'; // Cream
const CARD_BG    = '#fdfcfb'; // Block White
const SAGE       = '#7e998a'; 
const TEAL       = '#2a5c5d'; 
const MAHOGANY   = '#5c3a21'; 
const TEXT_MAIN  = '#2a3b38';
const BORDER     = '#d4cec4';

const LOOKBACK_OPTIONS = [
  { value: '100',  label: 'Current Regime', tag: '100d' },
  { value: '365',  label: 'Medium Term',    tag: '1yr' },
  { value: '730',  label: 'Post-Shock',     tag: '2yr' },
  { value: '1825', label: 'Structural',     tag: '5yr+' },
];

export default function App() {
  const [ticker, setTicker] = useState('SPY');
  const [lookback, setLookback] = useState('1825');
  const [driftMode, setDriftMode] = useState('blended');
  const [forecastDays, setForecastDays] = useState(252);
  const [numSims, setNumSims] = useState(400);
  const [logScale, setLogScale] = useState(false);
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

  const PAD = { top: 30, right: 20, bottom: 44, left: 75 };

  const formatPrice = (p) => {
    if (p >= 1000) return `$${(p / 1000).toFixed(1)}k`;
    return `$${p.toFixed(2)}`;
  };

  const getScalers = (range, days) => {
    const W = 1000, H = 500;
    const iW = W - PAD.left - PAD.right, iH = H - PAD.top - PAD.bottom;
    const lMin = Math.log(Math.max(range.min, 0.1)), lMax = Math.log(range.max);
    return {
      toX: d => PAD.left + (d / days) * iW,
      toY: p => {
          const val = Math.max(p, 0.1);
          const frac = logScale ? (Math.log(val) - lMin) / (lMax - lMin) : (p - range.min) / (range.max - range.min);
          return PAD.top + (1 - frac) * iH;
      }
    };
  };

  async function handleRun() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setStatus('computing');
    try {
      const res = await fetch(`/api/spy?ticker=${ticker}&lookback=${lookback}`);
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
      setCalibration({ ticker: data.ticker, mu: finalMu, sigma: Math.sqrt(histVar), rf: data.riskFreeRate });

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

  function drawPaths(ctx, from, to) {
    const { toX, toY } = getScalers(rangeRef.current, forecastDays);
    for (let i = from; i < to; i++) {
        const path = pathsRef.current[i];
        const finalP = path[path.length - 1];
        let opacity = 0.35;
        if (hoveredStat === 'bear') opacity = finalP <= stats.p5 ? 1.0 : 0.05;
        if (hoveredStat === 'bull') opacity = finalP >= stats.p95 ? 1.0 : 0.05;

        ctx.strokeStyle = `hsla(${165 + (i % 50)}, 35%, 45%, ${opacity})`;
        ctx.lineWidth = opacity > 0.5 ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(toX(0), toY(path[0]));
        path.forEach((p, d) => ctx.lineTo(toX(d), toY(p)));
        ctx.stroke();
    }
  }

  function startAnimation(liveStart) {
    const ctx = canvasRef.current.getContext('2d');
    const animate = () => {
      ctx.fillStyle = BG; ctx.fillRect(0, 0, 1000, 500);
      // Redraw grid
      const { toY } = getScalers(rangeRef.current, forecastDays);
      ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, 1000-PAD.left-PAD.right, 500-PAD.top-PAD.bottom);
      ctx.textAlign = 'right'; ctx.fillStyle = TEXT_MAIN;
      [0, 0.25, 0.5, 0.75, 1].forEach(f => {
        const p = rangeRef.current.min + f * (rangeRef.current.max - rangeRef.current.min);
        ctx.fillText(formatPrice(p), PAD.left - 10, toY(p) + 4);
      });

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

  // Redraw on hover
  useEffect(() => {
      if (status === 'done') {
          const ctx = canvasRef.current.getContext('2d');
          ctx.fillStyle = BG; ctx.fillRect(0, 0, 1000, 500);
          const { toY } = getScalers(rangeRef.current, forecastDays);
          ctx.strokeStyle = BORDER; ctx.strokeRect(PAD.left, PAD.top, 1000-PAD.left-PAD.right, 500-PAD.top-PAD.bottom);
          [0, 0.25, 0.5, 0.75, 1].forEach(f => {
            const p = rangeRef.current.min + f * (rangeRef.current.max - rangeRef.current.min);
            ctx.fillStyle = TEXT_MAIN; ctx.fillText(formatPrice(p), PAD.left - 10, toY(p) + 4);
          });
          drawPaths(ctx, 0, pathsRef.current.length);
      }
  }, [hoveredStat]);

  return (
    <div style={{ background: BG, minHeight: '100vh', padding: '30px', color: TEXT_MAIN, fontFamily: 'serif' }}>
      <style>{`
        .block { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 12px; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
        .stat-card { transition: 0.2s; border-left: 5px solid transparent; cursor: pointer; flex: 1; }
        .stat-card:hover { transform: translateY(-3px); background: #fff; box-shadow: 0 8px 20px rgba(0,0,0,0.05); }
        .lookback-btn { border: 1px solid ${BORDER}; background: #fff; padding: 12px; border-radius: 8px; cursor: pointer; flex: 1; text-align: center; transition: 0.2s; }
        .lookback-btn.active { background: ${TEAL}; color: white; border-color: ${TEAL}; }
        h1 { font-family: 'Syne', sans-serif; font-size: 38px; font-weight: 900; color: ${TEAL}; margin: 0; line-height: 1.2; padding-bottom: 12px; border-bottom: 3px solid ${MAHOGANY}; display: inline-block; }
        .label { font-size: 10px; font-weight: 800; color: ${SAGE}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; display: block; }
      `}</style>

      {/* Top Stat Strip */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '25px' }}>
        <div><h1>Risk Simulation Engine</h1></div>
        {stats && (
          <div style={{ display: 'flex', gap: '20px', width: '60%' }}>
             <div className="block stat-card">
               <span className="label">MEDIAN</span>
               <div style={{fontSize: '22px', fontWeight: 900}}>{formatPrice(stats.median)}</div>
             </div>
             <div className="block stat-card" style={{borderLeftColor: SAGE}}
                  onMouseEnter={() => setHoveredStat('bull')} onMouseLeave={() => setHoveredStat(null)}>
               <span className="label">BULL 95%</span>
               <div style={{fontSize: '22px', fontWeight: 900, color: SAGE}}>{formatPrice(stats.p95)}</div>
             </div>
             <div className="block stat-card" style={{borderLeftColor: MAHOGANY}}
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

      {/* Control Block */}
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
        </div>
        <div className="block">
          <span className="label">Asset Ticker</span>
          <input value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())} style={{width:'100%', padding:'12px', borderRadius:'8px', border:`1px solid ${BORDER}`, fontWeight:800, color:TEAL}} />
        </div>
        <div className="block">
          <span className="label">Drift Anchor</span>
          <select value={driftMode} onChange={e=>setDriftMode(e.target.value)} style={{width:'100%', padding:'12px', borderRadius:'8px', border:`1px solid ${BORDER}`, fontWeight:700}}>
            <option value="blended">Blended (Shrinkage)</option>
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

      {/* Main Analysis View */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
        <div className="block">
          <div style={{display:'flex', justifyContent:'space-between', marginBottom:'10px'}}>
             <span className="label" style={{color:TEXT_MAIN}}>Projected Trajectories ({forecastDays} Days)</span>
             {calibration && <span style={{fontSize:'11px', color:SAGE, fontWeight:700}}>Calib: {calibration.ticker} | σ: {(calibration.sigma*100).toFixed(1)}% | RF: {(calibration.rf*100).toFixed(2)}%</span>}
          </div>
          <canvas ref={canvasRef} width={1000} height={500} style={{ width: '100%', height: 'auto' }} />
          <input type="range" min="21" max="504" value={forecastDays} onChange={e=>setForecastDays(+e.target.value)} style={{width:'100%', marginTop:'15px', accentColor: TEAL}} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="block" style={{ height: '320px' }}>
            <span className="label">Final Distribution</span>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={histData} margin={{top:10, right:0, left:-25, bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} vertical={false} />
                <XAxis dataKey="priceLabel" tick={{fontSize:9}} interval={Math.floor(histData.length/4)} />
                <YAxis tick={{fontSize:9}} />
                <Bar dataKey="count">{histData.map((d, i) => <Cell key={i} fill={d.above ? SAGE : MAHOGANY} />)}</Bar>
                <Line dataKey="normalPdf" stroke={TEAL} dot={false} strokeWidth={2.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="block" style={{ borderLeft: `6px solid ${MAHOGANY}` }}>
             <span className="label" style={{color: MAHOGANY}}>Tail Risk (VaR 95%)</span>
             <div style={{fontSize: '32px', fontWeight: 900, color: MAHOGANY, marginTop:'5px'}}>{stats ? `-${stats.varPct}%` : '--'}</div>
             <p style={{fontSize:'11px', color:TEXT_MAIN, marginTop:'12px', lineHeight:1.5}}>
               Based on the Heston-Merton calibration, there is a 5% probability of a drawdown exceeding this threshold.
             </p>
          </div>
        </div>
      </div>
    </div>
  );
}
