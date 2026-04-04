import { useState, useRef, useEffect } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, ResponsiveContainer,
} from 'recharts';
import { runAllPaths, computeStats, buildHistogram } from './simulation.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const PATHS_PER_FRAME   = 5;
const HIST_UPDATE_EVERY = 25;
const BG      = '#070b14';
const GRID_C  = '#0d1f38';
const AXIS_C  = '#2d5a8a';
const CARD_BG = '#0d1626';
const BORDER  = '#1e3a5f';

// ── Lookback options ──────────────────────────────────────────────────────────
const LOOKBACK_OPTIONS = [
  {
    value:   '100', // Maps to 6mo in Yahoo
    label:   'Current Regime (6 Months)',
    desc:    'Calibrates μ and σ from the last ~6 months only. High recency bias — captures what the market is doing right now. Useful for short-term shock modelling.',
    tagLine: '⚡ Short-term bias',
    color:   '#f97316',
  },
  {
    value:   '365', // Maps to 1y in Yahoo
    label:   'Medium Term (1 Year)',
    desc:    'Balances recency with a full annual cycle. Captures seasonal patterns and recent volatility regime.',
    tagLine: '⚖ Balanced',
    color:   '#fbbf24',
  },
  {
    value:   '730', // Maps to 2y in Yahoo
    label:   'Post-Shock (2 Years)',
    desc:    'Includes the 2022 rate shock and subsequent recovery. Heavier σ, more conservative drift estimate.',
    tagLine: '📉 Rate shock included',
    color:   '#60a5fa',
  },
  {
    value:   '1825', // Maps to 5y in Yahoo
    label:   'Structural Trend (5+ Years)',
    desc:    'Spans COVID crash, recovery, bull run, and rate cycle. Best for long-term compounding analysis and 2030-horizon forecasts.',
    tagLine: '📈 Long-run structural',
    color:   '#22c55e',
  },
];

// ── Model options ─────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  { value: 'gbm',  label: 'Plain GBM', desc: 'Geometric Brownian Motion — constant vol, normally distributed returns.' },
  { value: 'jump', label: 'GBM + Jumps', desc: 'Merton (1976) — Poisson-distributed crash/rally events. Generates fat tails.' },
  { value: 'sv',   label: 'Stochastic Vol', desc: 'Heston model — vol is random, mean-reverting, negatively correlated with price.' },
  { value: 'full', label: '✦ Full Model', desc: 'Heston SV + Merton Jumps. Captures vol clustering, fat tails, crashes, leverage effect.' },
];

const DEFAULT_PARAMS = {
  mu: 0.10, sigma0: 0.18,
  kappa: 4.0, theta: 0.0324, xi: 0.35, rho: -0.70,
  jumpLambda: 5, jumpMu: -0.025, jumpSigma: 0.05,
};

// ─── Canvas helpers ───────────────────────────────────────────────────────────
const PAD = { top: 24, right: 20, bottom: 44, left: 68 };
function pathColor(i) { return `hsl(${(i * 137.508) % 360},${68 + (i % 3) * 9}%,${50 + (i % 5) * 5}%)`; }

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
    ctx.fillStyle = AXIS_C; ctx.fillText(`$${(price / 1000).toFixed(1)}k`, PAD.left - 5, y + 3);
  }

  const xLabels = days <= 63 ? ['Now','2w','1mo','6w','2mo','10w','3mo'] : days <= 252 ? ['Now','2mo','4mo','6mo','8mo','10mo','1yr'] : ['Now','4mo','8mo','1yr','16mo','20mo','2yr'];
  ctx.textAlign = 'center';
  for (let i = 0; i <= 6; i++) {
    const x = PAD.left + (i / 6) * iW;
    ctx.strokeStyle = GRID_C; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + iH); ctx.stroke();
    ctx.fillStyle = AXIS_C; ctx.fillText(xLabels[i] || '', x, H - PAD.bottom + 16);
  }

  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.strokeRect(PAD.left, PAD.top, iW, iH);
  const sy = toY(startPrice);
  ctx.strokeStyle = '#ffffff22'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(PAD.left, sy); ctx.lineTo(W - PAD.right, sy); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = '#ffffff30'; ctx.textAlign = 'right'; ctx.font = '9px IBM Plex Mono, monospace'; ctx.fillText('Today', W - PAD.right - 3, sy - 4);
}

function drawPaths(canvas, paths, from, to, range, days, log) {
  const ctx = canvas.getContext('2d');
  const { toX, toY } = makeScalers(canvas, range, days, log);
  ctx.globalAlpha = 0.48; ctx.lineWidth = 0.85;
  for (let s = from; s < to; s++) {
    ctx.strokeStyle = pathColor(s); ctx.beginPath(); ctx.moveTo(toX(0), toY(paths[s][0]));
    for (let d = 1; d < paths[s].length; d++) ctx.lineTo(toX(d), toY(paths[s][d]));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
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
  const [startPrice,   setStartPrice]   = useState(5540);

  const canvasRef = useRef(null), pathsRef = useRef([]), rangeRef = useRef(null), drawnRef = useRef(0), animRef = useRef(null), spRef = useRef(startPrice);
  spRef.current = startPrice;

  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current); }, []);
  useEffect(() => {
    if (status === 'done' && pathsRef.current.length > 0 && rangeRef.current) {
      initCanvas(canvasRef.current, rangeRef.current, forecastDays, spRef.current, logScale);
      drawPaths(canvasRef.current, pathsRef.current, 0, pathsRef.current.length, rangeRef.current, forecastDays, logScale);
    }
  }, [logScale]);

  // ── Clean Live Data Fetch ──────────────────────────────────────────────────
  async function fetchLiveData() {
    let backendLookback = '6mo';
    if (lookback === '365') backendLookback = '1y';
    if (lookback === '730') backendLookback = '2y';
    if (lookback === '1825') backendLookback = '5y';

    const res  = await fetch(`/api/spy?lookback=${backendLookback}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Server error (HTTP ${res.status})`);
    if (!data.prices || data.prices.length === 0) throw new Error("No data returned from Yahoo Finance.");

    return data; // Backend already mapped to { prices, startPrice, meta }
  }

  function startAnimation(paths, liveStart) {
    const animate = () => {
      const from = drawnRef.current, to = Math.min(from + PATHS_PER_FRAME, paths.length);
      drawPaths(canvasRef.current, paths, from, to, rangeRef.current, forecastDays, logScale);
      drawnRef.current = to; setCompleted(to);

      if (to % HIST_UPDATE_EVERY === 0 || to === paths.length) {
        const finals = paths.slice(0, to).map(p => p[p.length - 1]);
        setHistData(buildHistogram(finals, liveStart));
        if (to === paths.length) { setStats(computeStats(finals, liveStart)); setStatus('done'); return; }
      }
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
  }

  async function handleRun(demo) {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setStatus('computing'); setStats(null); setHistData([]); setCompleted(0); setError(''); setCalibration(null); drawnRef.current = 0;
    await new Promise(r => setTimeout(r, 30)); 

    let simParams = { ...params }, liveStart = startPrice;

    if (demo) {
      const demoCalib = { mu: 0.10, sigma0: 0.18, nu0: 0.0324, theta: 0.0324, jumpLambda: 5 };
      simParams = { ...params, ...demoCalib }; liveStart = 5540; setStartPrice(liveStart);
      setCalibration({ mu: demoCalib.mu, sigma: demoCalib.sigma0, source: 'Demo — S&P 500 averages', sessions: null, oldestDate: null, newestDate: null, lookbackLabel: 'N/A' });
    } else {
      let fetchResult;
      try { fetchResult = await fetchLiveData(); } catch (e) { setError(e.message); setStatus('idle'); return; }

      const calib = calibrateFromPrices(fetchResult.prices);
      liveStart = fetchResult.startPrice;

      simParams = { ...params, mu: calib.mu, sigma0: calib.sigma0, theta: showAdv ? params.theta : calib.theta, jumpLambda: showAdv ? params.jumpLambda : calib.jumpLambda };
      setStartPrice(liveStart);
      setParams(p => ({ ...p, mu: +calib.mu.toFixed(4), sigma0: +calib.sigma0.toFixed(4), theta: +calib.theta.toFixed(5), jumpLambda: +calib.jumpLambda.toFixed(1) }));

      const lbInfo = LOOKBACK_OPTIONS.find(o => o.value === lookback);
      setCalibration({ mu: calib.mu, sigma: calib.sigma0, source: fetchResult.meta.source, sessions: fetchResult.meta.sessionsReturned, oldestDate: fetchResult.meta.oldestDate, newestDate: fetchResult.meta.newestDate, lookbackLabel: lbInfo?.label || lookback });
    }

    const paths = runAllPaths({ ...simParams, startPrice: liveStart, forecastDays, numSims, model });
    pathsRef.current = paths;

    let minP = Infinity, maxP = -Infinity;
    for (const path of paths) { for (const p of path) { if (p < minP) minP = p; if (p > maxP) maxP = p; } }
    rangeRef.current = { min: minP * 0.95, max: maxP * 1.05 };

    spRef.current = liveStart; initCanvas(canvasRef.current, rangeRef.current, forecastDays, liveStart, logScale); setStatus('animating'); startAnimation(paths, liveStart);
  }

  const fmt = n => `$${Number(Math.round(n)).toLocaleString()}`, pct = n => `${(n * 100).toFixed(2)}%`;
  const isRunning = status === 'computing' || status === 'animating';
  const progress = numSims > 0 ? Math.round((completed / numSims) * 100) : 0;
  const selectedLB = LOOKBACK_OPTIONS.find(o => o.value === lookback) || LOOKBACK_OPTIONS[1];
  const selectedModel = MODEL_OPTIONS.find(m => m.value === model);
  const horizLabel = forecastDays === 21 ? '1 Month' : forecastDays === 63 ? '3 Months' : forecastDays === 126 ? '6 Months' : forecastDays === 252 ? '1 Year' : forecastDays === 504 ? '2 Years' : `${forecastDays}d`;

  return (
    <div style={{ background: BG, minHeight: '100vh', color: '#e2e8f0', fontFamily: "'IBM Plex Mono', monospace", padding: '18px 22px' }}>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } body { background: ${BG}; }
        input[type=range]  { accent-color: #00d4ff; width: 100%; cursor: pointer; }
        input[type=number] { background: ${BG}; border: 1px solid ${BORDER}; border-radius: 6px; padding: 7px 10px; color: #e2e8f0; font-family: inherit; font-size: 11px; outline: none; width: 100%; transition: border-color .15s; }
        input[type=number]:focus { border-color: #00d4ff; }
        select { background: ${BG}; border: 1px solid ${BORDER}; border-radius: 6px; padding: 8px 10px; color: #e2e8f0; font-family: inherit; font-size: 11px; outline: none; cursor: pointer; width: 100%; }
        .card { background: ${CARD_BG}; border: 1px solid ${BORDER}; border-radius: 10px; padding: 14px 16px; }
        .lbl  { font-size: 10px; color: #4a6fa5; letter-spacing: .1em; display: block; margin-bottom: 5px; }
        .btn  { border: none; border-radius: 8px; padding: 9px 20px; font-family: inherit; font-size: 11px; font-weight: 600; cursor: pointer; letter-spacing: .05em; transition: all .15s; }
        .btn:hover:not(:disabled) { filter: brightness(1.15); transform: translateY(-1px); } .btn:active:not(:disabled) { transform: none; } .btn:disabled { opacity: .38; cursor: not-allowed; }
        .pbar  { height: 2px; background: ${BORDER}; border-radius: 1px; overflow: hidden; } .pfill { height: 100%; background: linear-gradient(90deg,#0066ff,#00d4ff); transition: width .07s; }
        .regime-tag { display: inline-block; font-size: 9px; padding: 2px 7px; border-radius: 3px; font-weight: 600; margin-left: 6px; }
        .fade-in { animation: fi .4s ease; } @keyframes fi { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      `}</style>

      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, background: 'linear-gradient(135deg,#00d4ff,#0066ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            S&P 500 Monte Carlo
          </h1>
          <span className="regime-tag" style={{ background: selectedLB.color + '22', color: selectedLB.color, border: `1px solid ${selectedLB.color}44` }}>{selectedLB.tagLine}</span>
        </div>
        <div style={{ fontSize: 9, color: '#2d5a8a', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>{selectedModel?.label} · {numSims} paths · {horizLabel}</span>
          {status === 'computing' && <span style={{ color: '#fbbf24' }}>● Fetching & calibrating...</span>}
          {status === 'animating' && <span style={{ color: '#00d4ff' }}>● Simulating {progress}%</span>}
          {status === 'done'      && <span style={{ color: '#22c55e' }}>✓ Complete</span>}
        </div>
        {status === 'animating' && <div className="pbar" style={{ width: 200, marginTop: 5 }}><div className="pfill" style={{ width: `${progress}%` }} /></div>}

        {calibration && (
          <div className="fade-in" style={{ marginTop: 8, fontSize: 9, lineHeight: 1.9, color: '#2d5a8a', padding: '6px 10px', background: '#0a1020', borderRadius: 6, border: `1px solid ${BORDER}`, display: 'inline-block' }}>
            <span style={{ color: '#4a6fa5' }}>CALIBRATION · </span><span style={{ color: selectedLB.color }}>{calibration.lookbackLabel}</span>
            {calibration.sessions && <> · <span style={{ color: '#4a6fa5' }}>{calibration.sessions} sessions</span> · <span>{calibration.oldestDate}</span>{' → '}<span>{calibration.newestDate}</span></>}
            <br />Annualised μ = <span style={{ color: '#22c55e' }}>{pct(calibration.mu)}</span>&nbsp;·&nbsp;Annualised σ = <span style={{ color: '#f97316' }}>{pct(calibration.sigma)}</span>&nbsp;·&nbsp;<span style={{ color: '#1e4a70' }}>{calibration.source}</span>
          </div>
        )}

        {stats && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
            {[ { l: 'NOW', v: fmt(startPrice), c: '#9ca3af' }, { l: 'BEAR 5%', v: fmt(stats.p5), c: '#ef4444' }, { l: 'MEDIAN', v: fmt(stats.median), c: '#00d4ff' }, { l: 'BULL 95%', v: fmt(stats.p95), c: '#22c55e' }, { l: 'PROB UP', v: `${stats.probUp}%`, c: '#22c55e' }, { l: 'EXP RTN', v: `${stats.expectedReturn}%`, c: +stats.expectedReturn >= 0 ? '#22c55e' : '#ef4444' }].map(s => (
              <div key={s.l}><div style={{ fontSize: 8, color: '#2d5a8a', letterSpacing: '.1em' }}>{s.l}</div><div style={{ fontSize: 13, fontWeight: 600, color: s.c }}>{s.v}</div></div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(155px,1fr))', gap: '10px 18px', marginBottom: 12 }}>
          <div style={{ gridColumn: 'span 2' }}>
            <span className="lbl">LOOKBACK HORIZON<span style={{ marginLeft: 6, color: '#1e3a5f', fontStyle: 'italic', fontWeight: 400 }}>— dictates historical data calibration</span></span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
              {LOOKBACK_OPTIONS.map(opt => (
                <button key={opt.value} disabled={isRunning} onClick={() => setLookback(opt.value)}
                  style={{ padding: '8px 6px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600, transition: 'all .15s', textAlign: 'center',
                    border: lookback === opt.value ? `1.5px solid ${opt.color}` : `1px solid ${BORDER}`, background: lookback === opt.value ? opt.color + '18' : CARD_BG,
                    color: lookback === opt.value ? opt.color : '#4a6fa5', opacity: isRunning ? 0.4 : 1 }}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: '#1e4a70', marginTop: 5, padding: '5px 8px', background: '#070b14', borderRadius: 4 }}>{selectedLB.desc}</div>
          </div>
          <div><span className="lbl">STOCHASTIC MODEL</span><select value={model} onChange={e => setModel(e.target.value)} disabled={isRunning}>{MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
          <div><span className="lbl">PATHS: <span style={{ color: '#00d4ff' }}>{numSims}</span></span><input type="range" min={50} max={1000} step={50} value={numSims} onChange={e => setNumSims(+e.target.value)} disabled={isRunning} /></div>
          <div><span className="lbl">FORECAST: <span style={{ color: '#00d4ff' }}>{horizLabel}</span></span><input type="range" min={21} max={504} step={21} value={forecastDays} onChange={e => setForecastDays(+e.target.value)} disabled={isRunning} /></div>
          <div><span className="lbl">S₀ START PRICE</span><input type="number" value={startPrice} onChange={e => setStartPrice(+e.target.value)} disabled={isRunning} /></div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#4a6fa5', cursor: 'pointer', userSelect: 'none' }}><input type="checkbox" checked={logScale} style={{ accentColor: '#00d4ff' }} onChange={e => setLogScale(e.target.checked)} />Log scale</label>
          <span style={{ fontSize: 10, color: '#4a6fa5', cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowAdv(s => !s)}>⚙ Advanced params {showAdv ? '▲' : '▼'}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn" disabled={isRunning} onClick={() => handleRun(true)} style={{ background: '#0d1f38', border: `1px solid ${BORDER}`, color: '#00d4ff' }}>◈ Demo</button>
            <button className="btn" disabled={isRunning} onClick={() => handleRun(false)} style={{ background: 'linear-gradient(135deg,#0055cc,#00d4ff)', color: '#fff' }}>{isRunning ? '● Running...' : '▶ Live Run'}</button>
          </div>
        </div>

        {showAdv && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BORDER}`, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: '8px 16px' }}>
            <div style={{ gridColumn: '1/-1', fontSize: 9, color: '#1e4a70', marginBottom: 4 }}>⚠ When "Live Run" is used, μ, σ, θ, and λ are overridden by live calibration unless you run Demo Mode. Edit here to experiment with manual assumptions.</div>
            {[ { k: 'mu', l: 'DRIFT μ (ann.)', s: 0.01, mn: -0.3, mx: 0.5 }, { k: 'sigma0', l: 'INIT VOL σ', s: 0.01, mn: 0.05, mx: 1.0 }, { k: 'jumpLambda', l: 'JUMPS/YR λ', s: 0.5, mn: 0, mx: 20 }, { k: 'jumpMu', l: 'JUMP MEAN μⱼ', s: 0.01, mn: -0.3, mx: 0.2 }, { k: 'jumpSigma', l: 'JUMP STD σⱼ', s: 0.01, mn: 0.01, mx: 0.4 }, { k: 'kappa', l: 'MEAN-REV κ', s: 0.5, mn: 0.1, mx: 20 }, { k: 'theta', l: 'LONG-RUN VAR θ', s: 0.005,mn: 0.005,mx: 0.5 }, { k: 'xi', l: 'VOL-OF-VOL ξ', s: 0.05, mn: 0.05, mx: 2.0 }, { k: 'rho', l: 'LEVERAGE ρ', s: 0.05, mn: -1, mx: 0 }].map(p => (
              <div key={p.k}><span className="lbl">{p.l}: <span style={{ color: '#00d4ff' }}>{params[p.k]}</span></span><input type="number" value={params[p.k]} step={p.s} min={p.mn} max={p.mx} disabled={isRunning} onChange={e => setParams(prev => ({ ...prev, [p.k]: +e.target.value }))} /></div>
            ))}
          </div>
        )}
      </div>

      {error && <div style={{ background: '#1a0808', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 11, color: '#fca5a5', lineHeight: 1.7 }}>⚠ {error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 12, alignItems: 'start' }}>
        <div className="card" style={{ padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#2d5a8a', marginBottom: 8 }}><span>SIMULATED PRICE PATHS · {numSims.toLocaleString()} paths</span>{status !== 'idle' && <span>{completed.toLocaleString()} / {numSims.toLocaleString()} rendered</span>}</div>
          <div style={{ position: 'relative' }}>
            <canvas ref={canvasRef} width={1000} height={500} style={{ width: '100%', height: 'auto', borderRadius: 6, display: 'block', background: BG, border: `1px solid ${BORDER}` }} />
            {status === 'idle' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <div style={{ fontSize: 34, color: '#1e3a5f', marginBottom: 8 }}>◈</div><div style={{ fontSize: 11, color: '#1e3a5f', letterSpacing: '.2em' }}>AWAITING SIMULATION</div><div style={{ fontSize: 9, color: '#102030', marginTop: 5 }}>Click Live Run to fetch free data and begin</div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card">
            <div style={{ fontSize: 9, color: '#2d5a8a', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}><span>FINAL PRICE DISTRIBUTION</span>{status !== 'idle' && <span style={{ color: status === 'done' ? '#22c55e' : '#00d4ff' }}>{completed}/{numSims}</span>}</div>
            {histData.length > 0 ? (
              <ResponsiveContainer width="100%" height={195}>
                <ComposedChart data={histData} margin={{ top: 4, right: 4, left: -26, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="2 5" stroke={GRID_C} vertical={false} />
                  <XAxis dataKey="priceLabel" stroke={BORDER} tick={{ fill: AXIS_C, fontSize: 8 }} interval={Math.floor(histData.length / 5)} />
                  <YAxis stroke={BORDER} tick={{ fill: AXIS_C, fontSize: 8 }} />
                  <Tooltip contentStyle={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 10 }} formatter={(v, n) => [v, n === 'count' ? 'Simulations' : 'Normal fit']} labelFormatter={l => `~${l}`} />
                  <Bar dataKey="count" radius={[1, 1, 0, 0]} isAnimationActive={false}>{histData.map((d, i) => <Cell key={i} fill={d.above ? '#14532d' : '#7f1d1d'} stroke={d.above ? '#22c55e33' : '#ef444433'} />)}</Bar>
                  <Line dataKey="normalPdf" stroke="#fbbf24" strokeWidth={1.5} dot={false} isAnimationActive={false} strokeDasharray="3 2" />
                </ComposedChart>
              </ResponsiveContainer>
            ) : <div style={{ height: 195, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#1e3a5f' }}>Updates live as paths render...</div>}
          </div>

          {stats && (
            <div className="card fade-in">
              <div style={{ fontSize: 9, color: '#2d5a8a', marginBottom: 10 }}>STATISTICS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 12px', marginBottom: 10 }}>
                {[ { l: 'Expected Return', v: `${stats.expectedReturn}%`, c: +stats.expectedReturn >= 0 ? '#22c55e' : '#ef4444' }, { l: 'Prob. Higher', v: `${stats.probUp}%`, c: '#22c55e' }, { l: 'Prob. > +20%', v: `${stats.probUp20}%`, c: '#fbbf24' }, { l: 'Prob. < −20%', v: `${stats.probDn20}%`, c: '#ef4444' }, { l: 'Std Dev', v: fmt(stats.std), c: '#a78bfa' }, { l: 'Excess Kurtosis', v: stats.excessKurtosis, c: +stats.excessKurtosis > 0.5 ? '#f97316' : '#9ca3af' }].map(s => <div key={s.l}><div style={{ fontSize: 8, color: AXIS_C }}>{s.l}</div><div style={{ fontSize: 12, fontWeight: 600, color: s.c }}>{s.v}</div></div>)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, fontSize: 9, textAlign: 'center' }}>
                {[ { l: '5th', v: fmt(stats.p5), c: '#ef4444' }, { l: '25th', v: fmt(stats.p25), c: '#f97316' }, { l: '50th', v: fmt(stats.median), c: '#fff' }, { l: '75th', v: fmt(stats.p75), c: '#00d4ff' }, { l: '95th', v: fmt(stats.p95), c: '#22c55e' }, { l: 'Now', v: fmt(startPrice), c: '#6b7280' }].map(s => <div key={s.l} style={{ padding: '5px 2px', background: '#070b14', borderRadius: 4 }}><div style={{ color: '#2d5a8a' }}>{s.l}</div><div style={{ color: s.c, fontWeight: 600, fontSize: 11 }}>{s.v}</div></div>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
