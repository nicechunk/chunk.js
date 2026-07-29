export const MAIN_GAME_SUN_DIRECTION = Object.freeze(normalize3([-0.72, 0.34, 0.62]));

const UNDERWATER_LIGHTING = Object.freeze({
  skyColor: hexToRgb(0x0d4054),
  fogColor: hexToRgb(0x147286),
  sunColor: hexToRgb(0xa6d7d2),
  skyLightColor: hexToRgb(0x83d0cf),
  groundLightColor: hexToRgb(0x2a6d67),
  fogNearFar: [10, 112],
  ambientStrength: 0.52,
  sunStrength: 0.30,
  hemiStrength: 0.58,
  exposure: 1.00,
});

export const DEFAULT_WORLD_LIGHTING = Object.freeze({
  skyColor: hexToRgb(0x78c9ef),
  fogColor: hexToRgb(0xe1f5fb),
  sunDirection: MAIN_GAME_SUN_DIRECTION,
  sunColor: hexToRgb(0xfff0b8),
  sunDiscColor: hexToRgb(0xfff6c8),
  sunHaloColor: hexToRgb(0xffd47a),
  skyLightColor: hexToRgb(0xffffff),
  groundLightColor: hexToRgb(0x96aa72),
  ambientStrength: 0.36,
  sunStrength: 0.70,
  hemiStrength: 0.40,
  exposure: 1.03,
  fogNear: 112,
  fogFar: 360,
  mobileFogNear: 88,
  mobileFogFar: 260,
  mobileExposure: 1.00,
  sunDiscDistance: 430,
  sunDiscRadius: 24,
  sunDiscOpacity: 0.88,
});

export function createWorldLighting(options = {}, { mobile = isCoarsePointer() } = {}) {
  const base = DEFAULT_WORLD_LIGHTING;
  const fogNear = numberOr(options.fogNear, mobile ? base.mobileFogNear : base.fogNear);
  const fogFar = Math.max(fogNear + 1, numberOr(options.fogFar, mobile ? base.mobileFogFar : base.fogFar));
  const exposure = numberOr(options.exposure, mobile ? base.mobileExposure : base.exposure);
  const skyColor = colorOr(options.skyColor, base.skyColor);
  const fogColor = colorOr(options.fogColor, base.fogColor);
  return {
    skyColor,
    clearColor: [...skyColor, numberOr(options.clearAlpha, 1)],
    fogColor,
    fogNearFar: [fogNear, fogFar],
    sunDirection: normalize3(vectorOr(options.sunDirection, base.sunDirection)),
    sunColor: colorOr(options.sunColor, base.sunColor),
    sunDiscColor: colorOr(options.sunDiscColor, base.sunDiscColor),
    sunHaloColor: colorOr(options.sunHaloColor, base.sunHaloColor),
    skyLightColor: colorOr(options.skyLightColor, base.skyLightColor),
    groundLightColor: colorOr(options.groundLightColor, base.groundLightColor),
    ambientStrength: numberOr(options.ambientStrength, base.ambientStrength),
    sunStrength: numberOr(options.sunStrength, base.sunStrength),
    hemiStrength: numberOr(options.hemiStrength, base.hemiStrength),
    exposure,
    sunDiscDistance: numberOr(options.sunDiscDistance, base.sunDiscDistance),
    sunDiscRadius: numberOr(options.sunDiscRadius, base.sunDiscRadius),
    sunDiscOpacity: numberOr(options.sunDiscOpacity, base.sunDiscOpacity),
    cloudOpacity: 1,
    underwaterBlend: 0,
  };
}

export function createUnderwaterLighting(lighting, amount = 0) {
  const blend = clamp01(amount);
  if (!lighting || blend <= 0) return lighting;
  const skyColor = mixColor(lighting.skyColor, UNDERWATER_LIGHTING.skyColor, blend);
  return {
    ...lighting,
    skyColor,
    clearColor: [...skyColor, lighting.clearColor?.[3] ?? 1],
    fogColor: mixColor(lighting.fogColor, UNDERWATER_LIGHTING.fogColor, blend),
    fogNearFar: mixPair(lighting.fogNearFar, UNDERWATER_LIGHTING.fogNearFar, blend),
    sunColor: mixColor(lighting.sunColor, UNDERWATER_LIGHTING.sunColor, blend),
    skyLightColor: mixColor(lighting.skyLightColor, UNDERWATER_LIGHTING.skyLightColor, blend),
    groundLightColor: mixColor(lighting.groundLightColor, UNDERWATER_LIGHTING.groundLightColor, blend),
    ambientStrength: mixNumber(lighting.ambientStrength, UNDERWATER_LIGHTING.ambientStrength, blend),
    sunStrength: mixNumber(lighting.sunStrength, UNDERWATER_LIGHTING.sunStrength, blend),
    hemiStrength: mixNumber(lighting.hemiStrength, UNDERWATER_LIGHTING.hemiStrength, blend),
    exposure: mixNumber(lighting.exposure, UNDERWATER_LIGHTING.exposure, blend),
    sunDiscOpacity: Math.max(0, Number(lighting.sunDiscOpacity) || 0) * (1 - blend),
    cloudOpacity: numberOr(lighting.cloudOpacity, 1) * (1 - blend),
    underwaterBlend: blend,
  };
}

export function applyLightingUniforms(gl, uniforms, lighting) {
  if (!gl || !uniforms || !lighting) return;
  setUniform3(gl, uniforms.uSunDirection, lighting.sunDirection);
  setUniform3(gl, uniforms.uSunColor, lighting.sunColor);
  setUniform3(gl, uniforms.uSkyLightColor, lighting.skyLightColor);
  setUniform3(gl, uniforms.uGroundLightColor, lighting.groundLightColor);
  setUniform3(gl, uniforms.uFogColor, lighting.fogColor);
  if (uniforms.uFogNearFar) gl.uniform2f(uniforms.uFogNearFar, lighting.fogNearFar[0], lighting.fogNearFar[1]);
  if (uniforms.uLightParams) {
    gl.uniform4f(
      uniforms.uLightParams,
      lighting.ambientStrength,
      lighting.sunStrength,
      lighting.hemiStrength,
      lighting.exposure,
    );
  }
}

function setUniform3(gl, location, value) {
  if (!location || !value) return;
  gl.uniform3f(location, value[0], value[1], value[2]);
}

function colorOr(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])];
  if (typeof value === "number") return hexToRgb(value);
  return [...fallback];
}

function vectorOr(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  return [...fallback];
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function mixColor(from, to, amount) {
  return [0, 1, 2].map((index) => mixNumber(from?.[index], to[index], amount));
}

function mixPair(from, to, amount) {
  return [0, 1].map((index) => mixNumber(from?.[index], to[index], amount));
}

function mixNumber(from, to, amount) {
  const start = Number.isFinite(Number(from)) ? Number(from) : Number(to) || 0;
  return start + (to - start) * amount;
}

function hexToRgb(hex) {
  const value = Number(hex) >>> 0;
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function normalize3(value) {
  const x = Number(value?.[0]) || 0;
  const y = Number(value?.[1]) || 0;
  const z = Number(value?.[2]) || 0;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function isCoarsePointer() {
  return globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
}
