import { useState, useRef, useEffect } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, ResponsiveContainer,
} from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Cream/Sage/Teal Theme ───────────────────────────────────────────────────
const BG         = '#fdfcf9'; // Cream background
const CARD_BG    = '#f4f1ea'; // Slightly deeper cream for cards
const BORDER     = '#dcd5c6'; // Soft taupe border
const TEXT_MAIN  = '#2c363f'; // Charcoal slate text
const TEXT_MUTED = '#6b705c'; // Sage-tinted grey
const SAGE       = '#8a9a86'; // Core Sage Green
const TEAL       = '#2c5e5e'; // Deep Teal
const ACCENT_RED = '#b5655c'; // Soft terracotta for negatives
const GRID_C     = '#e5e2da'; // Subtle grid lines

// ── Lookback options ──────────────────────────────────────────────────────────
const LOOKBACK_OPTIONS = [
  { value: '100',  label: 'Current Regime (6M)', desc: 'High recency bias — captures immediate market shocks.' },
  { value: '365',  label: 'Medium Term (1Y)',    desc: 'Balances recency with a full annual cycle.' },
  { value: '730',  label: 'Post-Shock (2Y)',     desc: 'Captures mid-term rate cycle volatility.' },
  { value: '1825', label: 'Structural (5Y+)',    desc: 'Best for long-term compounding and tail-risk analysis.' },
];

const MODEL_OPTIONS = [
  { value: 'gbm',  label: 'Plain GBM', desc: 'Standard normal distribution. Baseline model.' },
  { value: 'jump', label: 'GBM + Jumps', desc: 'Merton (1976) — Adds Poisson crash/rally events.' },
  { value: 'sv',   label: 'Stochastic Vol', desc: 'Heston model — Volatility is random and mean-reverting.' },
  { value: 'full', label: '✦ Full Model', desc: 'Heston SV + Merton Jumps. Captures heavy tails and vol clustering.' },
];

const DEFAULT_PARAMS = {
  mu: 0.10, sigma0: 0.18,
  kappa: 4.0, theta: 0.0324, xi: 0.35, rho: -0.70,
  jumpLambda: 5, jumpMu: -0.025, jumpSigma: 0.05,
};

// ─── Canvas helpers ───────────────────────────────────────────────────────────
const PAD = { top: 24, right: 20, bottom: 44, left: 68 };

// Richer, darker colors for light theme paths
function pathColor(i) { 
  return `hsla(${(i * 137.508) % 360}, 45%, 45%, 0.5)`; 
}

function makeScalers(canvas, range, days, log) {
  const W = canvas.width, H = canvas.height;
  const iW = W - PAD.left - PAD.right, iH = H - PAD.top  - PAD.bottom;
  const logMin = Math.log(Math.max(range.min, 1)), logMax = Math.log(range.max);
  const toX = d => PAD.left + (d / days) * iW;
  const toY = p => {
    const frac = log ? (Math.log(Math.max(p, 0.01)) - logMin) / (logMax - logMin) : (p - range.min) / (range.max - range.min);
    return PAD.top + (1 - frac) * iH;
  };
  return { toX, toY, W, H, iW, iH };
}

function initCanvas(canvas, range, days, startPrice, log) {
  const ctx = canvas.getContext('2d');
  const { toX, toY, W, H, iW, iH } = makeScalers(canvas, range, days, log);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); ctx.font = '10px IBM Plex Mono, monospace';

  ctx.textAlign = 'right';
  for (let i = 0; i <= 6; i++) {
    const frac = i / 6;
    const price = log ? Math.exp(Math.log(Math.max(range.min, 1)) + (1 - frac) * (Math.log(range.max) - Math.log(Math.max(range.min, 1)))) : range.min + (1 - frac) * (range.max - range.min);
    const y = PAD.top + frac * iH;
    ctx.strokeStyle = GRID_C; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.fillStyle = TEXT_MUTED; ctx.fillText(`$${(price).toFixed(0)}`, PAD.left - 5, y + 3);
  }

  const xLabels = days <= 63 ? ['Now','2w','1mo','6w','2mo','10w','3mo'] : days <= 252 ? ['Now','2mo','4mo','6mo','8mo','10mo','1yr'] : ['Now','4mo','8mo','1yr','16mo','20mo','2yr'];
  ctx.textAlign = 'center';
  for (let i = 0; i <= 6; i++) {
    const x = PAD.left + (i / 6) * iW;
    ctx.strokeStyle = GRID_C; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + iH); ctx.stroke();
    ctx.fillStyle = TEXT_MUTED; ctx.fillText(xLabels[i] || '', x, H - PAD.bottom + 16);
  }

  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, iW, iH);
  const sy = toY(startPrice);
  ctx.strokeStyle = TEAL; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(PAD.left, sy); ctx.lineTo(W - PAD.right, sy); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = TEAL; ctx.textAlign = 'right'; ctx.font = '9px IBM Plex Mono, monospace'; ctx.fillText('Today', W - PAD.right - 3, sy - 4);
}

function drawPaths(canvas, paths, from, to, range, days, log) {
  const ctx = canvas.getContext('2d');
  const { toX, toY } = makeScalers(canvas, range, days, log);
  ctx.lineWidth = 1.0;
  for (let s = from; s < to; s++) {
    ctx.strokeStyle = pathColor(s); ctx.beginPath(); ctx.moveTo(toX(0), toY(paths[s][0]));
    for (let d = 1; d < paths[s].length; d++) ctx.lineTo(toX(d), toY(paths[s][d]));
    ctx.stroke();
  }
}

// ─── Calibration math ─────────────────────────────────────────────────────────
function calibrateFromPrices(prices) {
  const logReturns = [];
  for (let i = 1; i < prices.length; i++) logReturns.push(Math.log(prices[i] / prices[i - 1]));
  const n = logReturns.length;
  const muD = logReturns.reduce((a, b) => a + b, 0) / n;
  const varD = logReturns.reduce((a, b) => a + (b - muD) ** 2, 0) / (n - 1);
  const mu = muD * 252, sigma = Math.sqrt(varD * 252), nu0 = varD * 252;
  const jumpLambda = Math.max(2, Math.min(8, 500 / n));
  return { mu, sigma0: sigma, nu0, theta: nu0, jumpLambda };
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function App() {
  const [ticker,       setTicker]       = useState('SPY');
  const [model,        setModel]        = useState('full');
  const [numSims,      setNumSims]      = useState(400);
  const [forecastDays, setForecastDays] = useState(252);
  const [logScale,     setLogScale]     = useState(false);
  const [lookback,     setLookback]     = useState('1825');
  const [showAdv,      setShowAdv]      = useState(false);
  const [params,       setParams]       = useState(DEFAULT_PARAMS);

  const [status,       setStatus]       = useState('idle');
  const [completed,    setCompleted]    = useState(0);
  const [stats,        setStats]        = useState(null);
  const [histData,     setHistData]     = useState([]);
  const [error,        setError]        = useState('');
  const [calibration,  setCalibration]  = useState(null); 
  const [startPrice,   setStartPrice]   = useState(0);

  const canvasRef = useRef(null), pathsRef = useRef([]), rangeRef = useRef(null), drawnRef = useRef(0), animRef = useRef(null), spRef = useRef(startPrice);
  spRef.current = startPrice;

  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current); }, []);
  useEffect(() => {
    if (status === 'done' && pathsRef.current.length > 0 && rangeRef.current) {
      initCanvas(canvasRef.current, rangeRef.current, forecastDays, spRef.current, logScale);
      drawPaths(canvasRef.current, pathsRef.current, 0, pathsRef.current.length, rangeRef.current, forecastDays, logScale);
    }
  }, [logScale]);

  async function fetchLiveData() {
    let backendLookback = '6mo';
    if (lookback === '365') backendLookback = '1y';
    if (lookback === '730') backendLookback = '2y';
    if (lookback === '1825') backendLookback = '5y';

    const cleanTicker = ticker.trim() || 'SPY';
    const res  = await fetch(`/api/spy?lookback=${backendLookback}&ticker=${cleanTicker}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Server error (HTTP ${res.status})`);
    if (!data.prices || data.prices.length === 0) throw new Error(`No data returned for ${cleanTicker}.`);

    return data; 
  }

  function startAnimation(paths, liveStart) {
    const animate = () => {
      const from = drawnRef.current, to = Math.min(from + PATHS_PER_FRAME, paths.length);
      drawPaths(canvasRef.current, paths, from, to, rangeRef.current, forecastDays, logScale);
      drawnRef.current = to; setCompleted(to);

      if (to % HIST_UPDATE_EVERY === 0 || to === paths.length) {
        const finals = paths.slice(0, to).map(p => p[p.length - 1]);
        setHistData(buildHistogram(finals, liveStart));
        if (to === paths.length) { 
          const baseStats = computeStats(finals, liveStart);
          
          // Quant Risk Math: Expected Shortfall (CVaR)
          const p5Val = baseStats.p5;
          const tail = finals.filter(v => v <= p5Val);
          const cvar = tail.length > 0 ? tail.reduce((a,b)=>a+b,0) / tail.length : p5Val;
          const varPct = ((liveStart - p5Val) / liveStart) * 100;
          const cvarPct = ((liveStart - cvar) / liveStart) * 100;

          setStats({
            ...baseStats,
            cvar,
            varPct: varPct.toFixed(1),
            cvarPct: cvarPct.toFixed(1)
          });
          setStatus('done'); 
          return; 
        }
      }
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
  }

  async function handleRun() {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setStatus('computing'); setStats(null); setHistData([]); setCompleted(0); setError(''); setCalibration(null); drawnRef.current = 0;
    await new Promise(r => setTimeout(r, 30)); 

    let simParams = { ...params }, liveStart = startPrice;

    let fetchResult;
    try { fetchResult = await fetchLiveData(); } catch (e) { setError(e.message); setStatus('idle'); return; }

    const calib = calibrateFromPrices(fetchResult.prices);
    liveStart = fetchResult.startPrice;

    simParams = { ...params, mu: calib.mu, sigma0: calib.sigma0, theta: showAdv ? params.theta : calib.theta, jumpLambda: showAdv ? params.jumpLambda : calib.jumpLambda };
    setStartPrice(liveStart);
    setParams(p => ({ ...p, mu: +calib.mu.toFixed(4), sigma0: +calib.sigma0.toFixed(4), theta: +calib.theta.toFixed(5), jumpLambda: +calib.jumpLambda.toFixed(1) }));

    const lbInfo = LOOKBACK_OPTIONS.find(o => o.value === lookback);
    setCalibration({ ticker: fetchResult.ticker, mu: calib.mu, sigma: calib.sigma0, source: fetchResult.meta.source, sessions: fetchResult.meta.sessionsReturned, oldestDate: fetchResult.meta.oldestDate, newestDate: fetchResult.meta.newestDate, lookbackLabel: lbInfo?.label || lookback });

    const paths = runAllPaths({ ...simParams, startPrice: liveStart, forecastDays, numSims, model });
    pathsRef.current = paths;

    let minP = Infinity, maxP = -Infinity;
    for (const path of paths) { for (const p of path) { if (p < minP) minP = p; if (p > maxP) maxP = p; } }
    rangeRef.current = { min: minP * 0.95, max: maxP * 1.05 };

    spRef.current = liveStart; initCanvas(canvasRef.current, rangeRef.current, forecastDays, liveStart, logScale); setStatus('animating'); startAnimation(paths, liveStart);
  }

  const fmt = n => `$${Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, pct = n => `${(n * 100).toFixed(2)}%`;
  const isRunning = status === 'computing' || status === 'animating';
  const progress = numSims > 0 ? Math.round((completed / numSims) * 100) : 0;
  const selectedLB = LOOKBACK_OPTIONS.find(o => o.value === lookback) || LOOKBACK_OPTIONS[1];
  const selectedModel = MODEL_OPTIONS.find(m => m.value === model);
  const horizLabel = forecastDays === 21 ? '1 Month' : forecastDays === 63 ? '3 Months' : forecastDays === 126 ? '6 Months' : forecastDays === 252 ? '1 Year' : forecastDays === 504 ? '2 Years' : `${forecastDays}d`;

  return (
    <div style={{ background: BG, minHeight: '100vh', color: TEXT_MAIN, fontFamily: "'IBM Plex Mono', monospace", padding: '18px 22px' }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } body { background: ${BG}; }
        input[type=range]  { accent-color: ${TEAL}; width: 100%; cursor: pointer; }
        input[type=number], input[type=text] { background: #fff; border: 1px solid ${BORDER}; border-radius: 6px; padding: 7px 10px; color: ${TEXT_MAIN}; font-family: inherit; font-size: 12px; outline: none; width: 100%; transition: border-color .15s; }
        input[type=number]:focus, input[type=text]:focus { border-color: ${TEAL}; box-shadow: 0 0 0 2px ${TEAL}22; }
        select { background: #fff; border: 1px solid ${BORDER}; border-radius: 6px; padding: 8px 10px; color: ${TEXT_MAIN}; font-family: inherit; font-size: 11px; outline: none; cursor: pointer; width: 100%; }
        .card { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 10px; padding: 14px 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.02); }
        .lbl  { font-size: 10px; color: ${TEXT_MUTED}; letter-spacing: .1em; display: block; margin-bottom: 5px; font-weight: 600;}
        .btn  { border: none; border-radius: 6px; padding: 10px 24px; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; letter-spacing: .05em; transition: all .15s; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .btn:hover:not(:disabled) { filter: brightness(1.05); transform: translateY(-1px); } .btn:active:not(:disabled) { transform: none; } .btn:disabled { opacity: .5; cursor: not-allowed; }
        .pbar  { height: 3px; background: ${BORDER}; border-radius: 2px; overflow: hidden; } .pfill { height: 100%; background: ${TEAL}; transition: width .07s; }
        .regime-tag { display: inline-block; font-size: 10px; padding: 3px 8px; border-radius: 4px; font-weight: 600; margin-left: 10px; background: ${SAGE}22; color: ${TEAL}; border: 1px solid ${SAGE}55;}
        .fade-in { animation: fi .4s ease; } @keyframes fi { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      `}</style>

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 26, fontWeight: 800, color: TEAL, margin: 0 }}>
            Risk Simulation Engine
          </h1>
          {calibration && <span className="regime-tag">{calibration.ticker} ACTIVE</span>}
        </div>
        <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 4 }}>
          {selectedModel?.label} · {numSims} paths · {horizLabel}
        </div>
        {status === 'animating' && <div className="pbar" style={{ width: 200, marginTop: 8 }}><div className="pfill" style={{ width: `${progress}%` }} /></div>}
      </div>

      {/* Controls Card */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: '12px 20px', marginBottom: 16 }}>
          
          <div>
            <span className="lbl">TICKER SYMBOL</span>
            <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} disabled={isRunning} placeholder="e.g. SPY, QQQ, AAPL" style={{fontWeight: 'bold', color: TEAL}} />
          </div>

          <div>
            <span className="lbl">LOOKBACK HORIZON</span>
            <select value={lookback} onChange={e => setLookback(e.target.value)} disabled={isRunning}>
              {LOOKBACK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          
          <div><span className="lbl">STOCHASTIC MODEL</span><select value={model} onChange={e => setModel(e.target.value)} disabled={isRunning}>{MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
          <div><span className="lbl">PATHS: <span style={{ color: TEAL }}>{numSims}</span></span><input type="range" min={50} max={1000} step={50} value={numSims} onChange={e => setNumSims(+e.target.value)} disabled={isRunning} /></div>
          <div><span className="lbl">FORECAST: <span style={{ color: TEAL }}>{horizLabel}</span></span><input type="range" min={21} max={504} step={21} value={forecastDays} onChange={e => setForecastDays(+e.target.value)} disabled={isRunning} /></div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TEXT_MUTED, cursor: 'pointer', fontWeight: 600 }}>
            <input type="checkbox" checked={logScale} onChange={e => setLogScale(e.target.checked)} /> Log scale
          </label>
          <span style={{ fontSize: 11, color: TEXT_MUTED, cursor: 'pointer', fontWeight: 600 }} onClick={() => setShowAdv(s => !s)}>⚙ Parameters {showAdv ? '▲' : '▼'}</span>
          
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn" disabled={isRunning} onClick={handleRun} style={{ background: TEAL, color: '#fff' }}>
              {isRunning ? '● Simulating...' : '▶ Calibrate & Run'}
            </button>
          </div>
        </div>

        {showAdv && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${BORDER}`, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: '10px 20px' }}>
            <div style={{ gridColumn: '1/-1', fontSize: 10, color: ACCENT_RED, marginBottom: 4 }}>⚠ Live calibration overrides μ, σ, θ, and λ automatically. Edit here to force manual assumptions.</div>
            {[ { k: 'mu', l: 'DRIFT μ (ann.)', s: 0.01 }, { k: 'sigma0', l: 'INIT VOL σ', s: 0.01 }, { k: 'jumpLambda', l: 'JUMPS/YR λ', s: 0.5 }, { k: 'jumpMu', l: 'JUMP MEAN μⱼ', s: 0.01 }, { k: 'jumpSigma', l: 'JUMP STD σⱼ', s: 0.01 }, { k: 'kappa', l: 'MEAN-REV κ', s: 0.5 }, { k: 'theta', l: 'LONG-RUN VAR θ', s: 0.005 }, { k: 'xi', l: 'VOL-OF-VOL ξ', s: 0.05 }, { k: 'rho', l: 'LEVERAGE ρ', s: 0.05 }].map(p => (
              <div key={p.k}><span className="lbl">{p.l}: <span style={{ color: TEAL }}>{params[p.k]}</span></span><input type="number" value={params[p.k]} step={p.s} disabled={isRunning} onChange={e => setParams(prev => ({ ...prev, [p.k]: +e.target.value }))} /></div>
            ))}
          </div>
        )}
      </div>

      {error && <div style={{ background: '#fce8e6', border: `1px solid ${ACCENT_RED}`, borderRadius: 6, padding: '12px', marginBottom: 16, fontSize: 12, color: ACCENT_RED, fontWeight: 500 }}>⚠ {error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16, alignItems: 'start' }}>
        
        {/* Left Column: Canvas */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: TEXT_MUTED, marginBottom: 10, fontWeight: 600 }}>
              <span>MONTE CARLO PATHS</span>
              {status !== 'idle' && <span>{completed} / {numSims}</span>}
            </div>
            <div style={{ position: 'relative' }}>
              <canvas ref={canvasRef} width={1000} height={460} style={{ width: '100%', height: 'auto', borderRadius: 6, display: 'block', background: BG, border: `1px solid ${BORDER}` }} />
            </div>
          </div>
          
          {calibration && (
            <div className="card fade-in" style={{ fontSize: 11, color: TEXT_MUTED, lineHeight: 1.6 }}>
              <strong>Calibration Profile ({calibration.ticker}):</strong> Pulled {calibration.sessions} trading sessions ({calibration.oldestDate} to {calibration.newestDate}). 
              Engine calculated Annualised Drift (μ) at <strong style={{color: TEAL}}>{pct(calibration.mu)}</strong> and Base Volatility (σ) at <strong style={{color: ACCENT_RED}}>{pct(calibration.sigma)}</strong>.
            </div>
          )}
        </div>

        {/* Right Column: Stats & Histogram */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          {stats && (
            <div className="card fade-in">
              <div style={{ fontSize: 10, color: TEXT_MUTED, marginBottom: 12, fontWeight: 600 }}>TAIL RISK & RETURN PROFILE</div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: 16 }}>
                <div><div style={{ fontSize: 9, color: TEXT_MUTED }}>EXPECTED RETURN</div><div style={{ fontSize: 16, fontWeight: 700, color: +stats.expectedReturn >= 0 ? TEAL : ACCENT_RED }}>{stats.expectedReturn}%</div></div>
                <div><div style={{ fontSize: 9, color: TEXT_MUTED }}>WIN PROBABILITY</div><div style={{ fontSize: 16, fontWeight: 700, color: TEAL }}>{stats.probUp}%</div></div>
              </div>

              <div style={{ padding: '10px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: TEXT_MAIN, fontWeight: 700, marginBottom: 6 }}>Value at Risk (95% Confidence)</div>
                <div style={{ fontSize: 11, color: TEXT_MUTED }}>Maximum expected loss threshold.</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: ACCENT_RED, marginTop: 4 }}>-{stats.varPct}% <span style={{fontSize:11, color:TEXT_MUTED, fontWeight:400}}>({fmt(stats.p5)})</span></div>
              </div>

              <div style={{ padding: '10px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: TEXT_MAIN, fontWeight: 700, marginBottom: 6 }}>Expected Shortfall (CVaR)</div>
                <div style={{ fontSize: 11, color: TEXT_MUTED }}>If a crash breaks the VaR threshold, this is the average severity of the bloodbath.</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#8b0000', marginTop: 4 }}>-{stats.cvarPct}% <span style={{fontSize:11, color:TEXT_MUTED, fontWeight:400}}>({fmt(stats.cvar)})</span></div>
              </div>
            </div>
          )}

          <div className="card">
            <div style={{ fontSize: 10, color: TEXT_MUTED, marginBottom: 10, fontWeight: 600 }}>FINAL DISTRIBUTION</div>
            {histData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={histData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_C} vertical={false} />
                  <XAxis dataKey="priceLabel" stroke={TEXT_MUTED} tick={{ fill: TEXT_MUTED, fontSize: 9 }} interval={Math.floor(histData.length / 5)} />
                  <YAxis stroke={TEXT_MUTED} tick={{ fill: TEXT_MUTED, fontSize: 9 }} />
                  <Tooltip contentStyle={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 11, color: TEXT_MAIN }} formatter={(v, n) => [v, n === 'count' ? 'Simulations' : 'Normal fit']} labelFormatter={l => `Price: ~${l}`} />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>{histData.map((d, i) => <Cell key={i} fill={d.above ? TEAL : ACCENT_RED} />)}</Bar>
                  <Line dataKey="normalPdf" stroke={SAGE} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            ) : <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: TEXT_MUTED }}>Distribution maps as paths render...</div>}
          </div>

        </div>
      </div>
    </div>
  );
}
