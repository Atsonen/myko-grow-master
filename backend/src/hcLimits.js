// Pure helpers for PID_Temp H/C output limits (unit-tested in test/hcLimits.test.js).
// OFF = 0 (zero span -> that output is NaN, i.e. off). Do NOT use an epsilon: outputs are scaled over the limit span,
// so a 0.01 span means full 100 % output. Restoring ON requires a ModeActivate to clear the latched NaN (pid.js).
export function hcWantFor(on, heat, cool, eps = 0) {
  const heatOn = Number(on?.heatOn) > 0 ? Number(on.heatOn) : 100;
  const coolOn = Number(on?.coolOn) < 0 ? Number(on.coolOn) : -100;
  return { HeatUpperLimit: heat ? heatOn : eps, CoolLowerLimit: cool ? coolOn : eps ? -eps : 0 };
}
export function hcMatches(want, read, tol = 0.001) {
  return Object.keys(want).every((m) => read && Number.isFinite(Number(read[m])) && read[m] !== null && Math.abs(Number(read[m]) - want[m]) <= tol);
}
