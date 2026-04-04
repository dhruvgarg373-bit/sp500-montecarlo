export function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function correlatedNormals(rho) {
  const z1 = randn();
  const z2 = randn();
  return [z1, rho * z1 + Math.sqrt(1 - rho * rho) * z2];
}

export function runAllPaths(params) {
  const {
    startPrice, mu, sigma0, forecastDays, numSims, model,
    jumpLambda, jumpMu, jumpSigma,
    kappa, theta, xi, rho,
  } = params;

  const dt = 1 / 252;
  const sqrtDt = Math.sqrt(dt);
  const kBar = Math.exp(jumpMu + 0.5 * jumpSigma * jumpSigma) - 1;
  const lambdaAdj = (model === 'jump' || model === 'full') ? jumpLambda * kBar : 0;

  const paths = [];

  for (let s = 0; s < numSims; s++) {
    const path = new Array(forecastDays + 1);
    path[0] = startPrice;
    let price = startPrice;
    let variance = sigma0 * sigma0;

    for (let d = 0; d < forecastDays; d++) {
      const sigma = Math.sqrt(Math.max(variance, 0.0001));
      let dW1, dW2;

      if (model === 'sv' || model === 'full') {
        [dW1, dW2] = correlatedNormals(rho);
      } else {
        dW1 = randn(); dW2 = randn();
      }

      let jumpReturn = 0;
      if ((model === 'jump' || model === 'full') && Math.random() < jumpLambda * dt) {
        jumpReturn = jumpMu + jumpSigma * randn();
      }

      price *= Math.exp(
        (mu - lambdaAdj - 0.5 * variance) * dt +
        sigma * sqrtDt * dW1 +
        jumpReturn
      );
      path[d + 1] = price;

      if (model === 'sv' || model === 'full') {
        variance = Math.max(
          variance + kappa * (theta - variance) * dt + xi * sigma * sqrtDt * dW2,
          0.0001
        );
      }
    }
    paths.push(path);
  }
  return paths;
}

function sortedPct(sorted, p) {
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function computeStats(finalPrices, startPrice) {
  const sorted = [...finalPrices].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = finalPrices.reduce((a, b) => a + b, 0) / n;
  const variance = finalPrices.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const skew = finalPrices.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / n;
  const kurt = finalPrices.reduce((a, b) => a + ((b - mean) / std) ** 4, 0) / n - 3;

  return {
    mean: Math.round(mean), median: Math.round(sortedPct(sorted, 50)),
    std: Math.round(std),
    skewness: skew.toFixed(3), excessKurtosis: kurt.toFixed(3),
    p5:  Math.round(sortedPct(sorted, 5)),
    p25: Math.round(sortedPct(sorted, 25)),
    p75: Math.round(sortedPct(sorted, 75)),
    p95: Math.round(sortedPct(sorted, 95)),
    probUp:   ((finalPrices.filter(p => p > startPrice).length / n) * 100).toFixed(1),
    probUp20: ((finalPrices.filter(p => p > startPrice * 1.2).length / n) * 100).toFixed(1),
    probDn20: ((finalPrices.filter(p => p < startPrice * 0.8).length / n) * 100).toFixed(1),
    expectedReturn: (((mean / startPrice) - 1) * 100).toFixed(2),
  };
}

export function buildHistogram(finalPrices, startPrice, buckets = 50) {
  if (finalPrices.length < 2) return [];
  const lo = Math.min(...finalPrices), hi = Math.max(...finalPrices);
  const bw = (hi - lo) / buckets;
  const counts = new Array(buckets).fill(0);
  finalPrices.forEach(p => counts[Math.min(buckets - 1, Math.floor((p - lo) / bw))]++);
  const n = finalPrices.length;
  const mean = finalPrices.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(finalPrices.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

  return Array.from({ length: buckets }, (_, i) => {
    const price = lo + (i + 0.5) * bw;
    const normalPdf = Math.round(
      (1 / (std * Math.sqrt(2 * Math.PI))) *
      Math.exp(-0.5 * ((price - mean) / std) ** 2) * n * bw
    );
    return {
      price: Math.round(price),
      priceLabel: `$${(price / 1000).toFixed(1)}k`,
      count: counts[i], normalPdf,
      above: price > startPrice,
    };
  });
}
