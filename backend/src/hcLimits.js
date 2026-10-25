// Pure helpers for PID_Temp H/C branch switching (unit-tested in test/hcLimits.test.js).
// PID_Temp scales each output between its limit pair (e.g. OutputHeat: Heat.PidLowerLimit=0 -> LowerScaling,
// Heat.PidUpperLimit -> UpperScaling). Rules learned the hard way (2026-10-25):
//  - never a zero-width span (limit 0 with the fixed 0 partner): output = NaN, PWM/PID output freezes for hours
//  - never a tiny span with normal scaling (0.01 => PidOutputSum 0.01 = 100 % output)
// Safe branch OFF:
//  - cool off: Config.ActivateCooling = FALSE (Siemens: PidOutputSum then limited to [Heat.PidLowerLimit, Heat.PidUpperLimit]);
//    Cool.PidLowerLimit stays at its valid ON value.
//  - heat off (cool on): Heat.PidUpperLimit = 1 (sum clamp [-100, 1], tiny windup) AND heat upper scalings = 0
//    (= lower scalings) so every heat output is pinned to 0 regardless of the sum.
//  - both off: PID Inactive (Mode 0) with the full ON config (pid.js).
export const HEAT_OFF_LIMIT = 1;
export const DEFAULT_HEAT_SCALING = { HeatUpperScaling: 100, HeatPwmUpperScaling: 100, HeatPerUpperScaling: 27648 };
export function hcWantFor(on, heat, cool) {
  const heatOn = Number(on?.heatOn) > HEAT_OFF_LIMIT ? Number(on.heatOn) : 100;
  const coolOn = Number(on?.coolOn) < 0 ? Number(on.coolOn) : -100;
  const sc = { ...DEFAULT_HEAT_SCALING, ...(on?.heatScaling ?? {}) };
  const h = heat || !cool; // both off => full ON config (PID is put Inactive separately)
  return {
    HeatUpperLimit: h ? heatOn : HEAT_OFF_LIMIT,
    HeatUpperScaling: h ? sc.HeatUpperScaling : 0,
    HeatPwmUpperScaling: h ? sc.HeatPwmUpperScaling : 0,
    HeatPerUpperScaling: h ? sc.HeatPerUpperScaling : 0,
    CoolLowerLimit: coolOn,
    ActivateCooling: Boolean(cool || !heat),
  };
}
// write order so no intermediate state gives unintended output:
// heat turning OFF -> scalings to 0 before the limit drops to 1; heat ON -> limit up before scalings come back.
export function hcWriteOrder(want) {
  const heatOff = want.HeatUpperLimit === HEAT_OFF_LIMIT;
  const sc = ["HeatPwmUpperScaling", "HeatUpperScaling", "HeatPerUpperScaling"];
  const heat = heatOff ? [...sc, "HeatUpperLimit"] : ["HeatUpperLimit", ...sc];
  const cool = want.ActivateCooling ? ["CoolLowerLimit", "ActivateCooling"] : ["ActivateCooling", "CoolLowerLimit"];
  return heatOff ? [...heat, ...cool] : [...cool, ...heat];
}
export function hcMatches(want, read, tol = 0.001) {
  return Object.keys(want).every((m) => read && read[m] !== null && read[m] !== undefined && Number.isFinite(Number(read[m])) &&
    (typeof want[m] === "boolean" ? Boolean(read[m]) === want[m] : Math.abs(Number(read[m]) - want[m]) <= tol));
}
// PID_LAHTO_JUMISSA: output frozen while PV off SP and not legitimately clamped
export function outputStuck({ state, outSum, pv, sp, manEn }, lim) {
  if (state !== 3 || manEn || ![outSum, pv, sp].every(Number.isFinite)) return false;
  const e = sp - pv;
  if (Math.abs(e) < 0.0625) return false;
  if (e > 0 && outSum >= lim.upper - 0.01) return false; // wants more heat, already at the top clamp
  if (e < 0 && outSum <= lim.lower + 0.01) return false; // wants more cooling, already at the bottom clamp
  return true;
}
