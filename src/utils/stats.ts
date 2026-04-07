/**
 * Statistical Utility Functions
 *
 * 회귀 탐지, 프롬프트 비교, 비용-품질 분석 등에서
 * 공통으로 사용하는 통계 함수를 모아둔다.
 * 외부 의존성 없이 순수 수학만으로 구현.
 */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

export function stddev(values: number[]): number {
  return Math.sqrt(variance(values));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Cohen's d — effect size between two groups.
 * |d| < 0.2 = negligible, 0.2-0.5 = small, 0.5-0.8 = medium, > 0.8 = large
 */
export function cohensD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const mA = mean(a);
  const mB = mean(b);
  const pooledVar =
    ((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) /
    (a.length + b.length - 2);
  const pooledSd = Math.sqrt(pooledVar);
  if (pooledSd === 0) return 0;
  return (mB - mA) / pooledSd;
}

/**
 * Welch's t-test — does not assume equal variances.
 * Returns { t, df, p } where p is two-tailed p-value.
 */
export function welchTTest(
  a: number[],
  b: number[],
): { t: number; df: number; p: number } {
  if (a.length < 2 || b.length < 2) {
    return { t: 0, df: 0, p: 1 };
  }

  const mA = mean(a);
  const mB = mean(b);
  const vA = variance(a);
  const vB = variance(b);
  const nA = a.length;
  const nB = b.length;

  const seA = vA / nA;
  const seB = vB / nB;
  const seDiff = Math.sqrt(seA + seB);

  if (seDiff === 0) return { t: 0, df: nA + nB - 2, p: 1 };

  const t = (mB - mA) / seDiff;

  // Welch-Satterthwaite degrees of freedom
  const df = (seA + seB) ** 2 / (seA ** 2 / (nA - 1) + seB ** 2 / (nB - 1));

  // Two-tailed p-value approximation using the t-distribution CDF
  const p = tDistPValue(Math.abs(t), df);

  return { t, df, p };
}

/**
 * Two-tailed p-value from t-distribution.
 * Uses the regularized incomplete beta function approximation.
 */
function tDistPValue(t: number, df: number): number {
  // Using the relationship: p = I(df/(df+t^2); df/2, 1/2)
  const x = df / (df + t * t);
  return regularizedBeta(x, df / 2, 0.5);
}

/**
 * Regularized incomplete beta function I_x(a, b)
 * Computed via continued fraction expansion (Lentz's method).
 */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry if needed for convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedBeta(1 - x, b, a);
  }

  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(
    Math.log(x) * a + Math.log(1 - x) * b - lnBeta,
  ) / a;

  // Lentz's continued fraction
  let f = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let i = 1; i <= 200; i++) {
    const m = i;
    // Even step
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= c * d;

    // Odd step
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

/** Lanczos approximation of log(Gamma(x)) */
function logGamma(x: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  if (x < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
    );
  }

  x -= 1;
  let sum = coef[0];
  for (let i = 1; i < g + 2; i++) {
    sum += coef[i] / (x + i);
  }
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * Proportion z-test — compare two error rates.
 * Returns two-tailed p-value.
 */
export function proportionTest(
  successA: number, nA: number,
  successB: number, nB: number,
): number {
  if (nA === 0 || nB === 0) return 1;
  const pA = successA / nA;
  const pB = successB / nB;
  const pPooled = (successA + successB) / (nA + nB);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / nA + 1 / nB));
  if (se === 0) return 1;
  const z = (pB - pA) / se;
  // Approximate two-tailed p using normal CDF
  return 2 * (1 - normalCDF(Math.abs(z)));
}

/** Standard normal CDF approximation (Abramowitz & Stegun) */
function normalCDF(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/** Classify effect size into severity */
export function classifyEffectSize(d: number): "none" | "minor" | "major" | "critical" {
  const abs = Math.abs(d);
  if (abs < 0.2) return "none";
  if (abs < 0.5) return "minor";
  if (abs < 0.8) return "major";
  return "critical";
}

/** Relative change as percentage */
export function deltaPct(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : Infinity;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}
