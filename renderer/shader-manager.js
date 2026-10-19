export const OPAQUE_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in ivec4 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec2 aLayerFlags;
layout(location = 4) in float aAo;

uniform mat4 uViewProjection;
uniform vec3 uChunkOrigin;

uniform float uTileScale;

out vec3 vNormal;
out vec2 vUv;
out float vLayer;
out float vAo;
out float vSunVisibility;
out float vSkyVisibility;
out float vFogDepth;
out vec3 vViewPosition;
out float vLocalLight;

void main() {
  float positionScale = max(1.0, float(aPosition.w));
  vec3 p = vec3(float(aPosition.x), float(aPosition.y), float(aPosition.z)) / positionScale + uChunkOrigin;
  gl_Position = uViewProjection * vec4(p, 1.0);
  vNormal = normalize(aNormal);
  vAo = aAo;
  vUv = aUv * uTileScale;
  vLayer = aLayerFlags.x;
  float packedFlags = floor(aLayerFlags.y + 0.5);
  float baseFlags = mod(packedFlags, 256.0);
  float hasBakedLight = step(127.5, baseFlags);
  float packedLight = floor(packedFlags / 256.0);
  float bakedSun = floor(packedLight / 16.0) / 15.0;
  float bakedSky = mod(packedLight, 16.0) / 15.0;
  vSunVisibility = mix(1.0, bakedSun, hasBakedLight);
  vSkyVisibility = mix(1.0, bakedSky, hasBakedLight);
  vFogDepth = max(0.0, gl_Position.w);
  vViewPosition = p;
  vLocalLight = mod(floor(baseFlags / 8.0), 16.0) / 15.0;
}
`;

export const OPAQUE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp int;

uniform sampler2DArray uTextureArray;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyLightColor;
uniform vec3 uGroundLightColor;
uniform vec3 uFogColor;
uniform vec2 uFogNearFar;
uniform vec4 uLightParams;
uniform float uTime;
uniform float uOpacity;
uniform float uUnderwater;
uniform float uSurfacePass;
uniform float uCaveAmbientFloor;
uniform vec3 uLocalLightColor;
uniform vec3 uCameraLocalEye;
uniform vec2 uWaterOriginPhase;
uniform ivec2 uWaterCellOrigin[6];
uniform vec2 uWaterCellPhase[6];

in vec3 vNormal;
in vec2 vUv;
in float vLayer;
in float vAo;
in float vSunVisibility;
in float vSkyVisibility;
in float vFogDepth;
in vec3 vViewPosition;
in float vLocalLight;

out vec4 outColor;

float waterHash(ivec2 p) {
  uvec2 v=uvec2(p);
  uint h=v.x*0x8da6b343u ^ v.y*0xd8163841u;
  h^=h>>16;h*=0x7feb352du;h^=h>>15;h*=0x846ca68bu;h^=h>>16;
  return float(h & 0x00ffffffu)/16777216.0;
}
vec2 waterGrid(vec2 p,float size,int index){return p/size+uWaterCellPhase[index];}
float waterNoise(vec2 p,float size,int index){return waterHash(ivec2(floor(waterGrid(p,size,index)))+uWaterCellOrigin[index]);}
float waterWave(vec2 p, vec2 dir, float speed, float freq, float phase) {
  // Integer wave numbers give an exact 256-block period; the CPU reduces the
  // high precision world origin before upload. Never reconstruct absolute floats.
  vec2 lattice=floor(dir*freq*128.0+0.5);
  return sin(fract(dot(p+uWaterOriginPhase,lattice)/256.0+phase*0.5+uTime*speed*0.5)*6.28318530718);
}
float waterLine(vec2 p, vec2 dir, float freq, float speed, float width, float phase) {
  vec2 lattice=floor(dir*freq*256.0+0.5);
  float v=fract(dot(p+uWaterOriginPhase,lattice)/256.0+uTime*speed+phase);
  float d=abs(v-0.5);return 1.0-smoothstep(width,width+0.035,d);
}

float waterSparkleCell(vec2 p, float cellSize, float density, float seed, int index) {
  vec2 grid = waterGrid(p,cellSize,index);
  ivec2 cell = ivec2(floor(grid))+uWaterCellOrigin[index];
  vec2 local = fract(grid);
  ivec2 seedOffset = ivec2(int(seed), int(seed * 1.731));
  float pick = waterHash(cell + seedOffset);
  float cellActive = step(1.0 - density, pick);
  vec2 center = vec2(
    waterHash(cell + seedOffset + ivec2(11.13, 5.91)),
    waterHash(cell + seedOffset + ivec2(3.77, 17.41))
  );
  center = mix(vec2(0.24), vec2(0.76), center);
  vec2 halfSize = vec2(
    0.065 + waterHash(cell + seedOffset + ivec2(19.27, 2.43)) * 0.165,
    0.040 + waterHash(cell + seedOffset + ivec2(7.81, 23.59)) * 0.125
  );
  halfSize = mix(halfSize, halfSize.yx, step(0.5, waterHash(cell + seedOffset + ivec2(31.7, 9.2))));
  float boxEdge = max(abs(local.x - center.x) - halfSize.x, abs(local.y - center.y) - halfSize.y);
  float feather = 0.050 + waterHash(cell + seedOffset + ivec2(29.5, 13.4)) * 0.050;
  float coreBox = 1.0 - smoothstep(0.0, feather * 0.70, boxEdge);
  float haloBox = 1.0 - smoothstep(feather * 0.35, feather * 3.80, boxEdge);
  float blinkPhase = pick * 6.2831853 + waterHash(cell + seedOffset + ivec2(41.0, 37.0)) * 2.8;
  float blink = smoothstep(-0.28, 0.94, sin(uTime * (1.15 + pick * 1.85) + blinkPhase));
  blink *= blink;
  float glowBox = max(coreBox, haloBox * 0.44);
  return cellActive * glowBox * (0.30 + blink * 0.70) * (0.68 + pick * 0.32);
}

vec3 animeGrade(vec3 color) {
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma), color, 0.98);
  color = color * 1.018 + vec3(0.016, 0.017, 0.012);
  return min(color, vec3(1.07));
}

void main() {
  float layer = floor(vLayer + 0.5);
#ifdef NICECHUNK_SOLID_PASS
  bool isWaterSurface = false;
#else
  bool isWaterSurface = layer >= 17.0 && layer <= 19.0;
#endif
  bool isShadowLayer = layer == 54.0;
  vec2 tileUv = fract(vUv);
  vec4 texel = textureGrad(uTextureArray, vec3(tileUv, layer), dFdx(vUv), dFdy(vUv));
  if (uSurfacePass > 0.5 && texel.a < 0.5) discard;
  if (uSurfacePass > 0.5) texel.a = 1.0;
  if (texel.a < 0.08) discard;
  if (isShadowLayer) {
    float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vFogDepth);
    vec3 shadowColor = mix(vec3(0.020, 0.028, 0.018), uFogColor * 0.22, fog * 0.36);
    outColor = vec4(shadowColor, texel.a * clamp(vAo, 0.0, 1.0) * (1.0 - fog * 0.48));
    return;
  }
  vec3 normal = normalize(vNormal);
  bool isWaterUnderside = isWaterSurface && normal.y < -0.5;
  float sun = max(dot(normal, normalize(uSunDirection)), 0.0);
  float toonSun = mix(sun, smoothstep(0.10, 0.82, sun), 0.55);
  float hemiUp = normal.y * 0.5 + 0.5;
  vec3 ambient = uSkyLightColor * uLightParams.x;
  vec3 hemi = mix(uGroundLightColor, uSkyLightColor, hemiUp) * uLightParams.z;
  vec3 direct = uSunColor * (toonSun * uLightParams.y * clamp(vSunVisibility, 0.0, 1.0));
  float indirectVisibility = mix(clamp(uCaveAmbientFloor,0.0,1.0), 1.0, clamp(vSkyVisibility, 0.0, 1.0));
  vec3 color = texel.rgb * ((ambient + hemi) * indirectVisibility + direct + uLocalLightColor * vLocalLight);
  float waterGlareCore = 0.0;
  float waterGlareHalo = 0.0;
  float aoValue = clamp(vAo, 0.0, 1.0);
  color *= isWaterSurface ? mix(0.78, 1.0, aoValue) : mix(0.64, 1.0, aoValue);
  if (!isWaterSurface && layer != 20.0) {
    float topFace = smoothstep(0.42, 0.88, normal.y);
    float sideFace = 1.0 - smoothstep(0.35, 0.82, abs(normal.y));
    color += vec3(0.040, 0.035, 0.012) * topFace;
    float sideShade = sideFace * (0.10 + (1.0 - toonSun) * 0.42);
    color *= mix(1.0, 0.925, sideShade);
  }
#ifndef NICECHUNK_SOLID_PASS
  if (layer >= 17.0 && layer <= 20.0) {
    vec2 p = vViewPosition.xz;
    vec2 d1 = normalize(vec2(0.68, 1.0));
    vec2 d2 = normalize(vec2(-0.92, 0.38));
    vec2 d3 = normalize(vec2(0.24, -0.98));
    float w1 = waterWave(p, d1, 0.24, 0.28, 7.0);
    float w2 = waterWave(p, d2, -0.18, 0.42, 11.0);
    float w3 = waterWave(p, d3, 0.11, 0.18, 17.0);
    float ripple = (w1 * 0.45 + w2 * 0.32 + w3 * 0.23) * 0.5 + 0.5;
    float fineA = waterLine(p, normalize(vec2(0.92, -0.24)), 0.22, 0.018, 0.026, 5.0);
    float fineB = waterLine(p, normalize(vec2(0.36, 1.0)), 0.34, -0.014, 0.022, 9.0);
    float fineC = waterLine(p, normalize(vec2(-0.72, 0.42)), 0.48, 0.012, 0.018, 13.0);
    vec2 grad = d1 * waterWave(p,d1,0.42,0.64,0.5) * 0.64 * 0.45;
    grad += d2 * waterWave(p,d2,-0.29,1.12,0.5) * 1.12 * 0.32;
    grad += d3 * waterWave(p,d3,0.17,0.28,0.5) * 0.28 * 0.23;
    vec3 waterNormal = normalize(vec3(-grad.x * 0.34, 1.0, -grad.y * 0.34));
    vec3 sunDir = normalize(uSunDirection);
    vec3 viewDir = normalize(uCameraLocalEye-vViewPosition + vec3(0.001, 0.001, 0.001));
    vec3 halfDir = normalize(sunDir + viewDir);
    float cameraDistance = length(vViewPosition.xz-uCameraLocalEye.xz);
    float distanceFactor = smoothstep(18.0, 240.0, cameraDistance);
    vec2 sun2 = normalize(sunDir.xz + vec2(0.001, 0.001));
    vec2 cameraToWater = normalize(vViewPosition.xz-uCameraLocalEye.xz + vec2(0.001, 0.001));
    float sunTrail = smoothstep(0.36, 0.96, dot(cameraToWater, sun2));
    sunTrail *= smoothstep(4.0, 26.0, cameraDistance) * (1.0 - smoothstep(250.0, 440.0, cameraDistance));
    float specular = pow(max(dot(waterNormal, halfDir), 0.0), 22.0);
    float sharpSpecular = pow(max(dot(waterNormal, halfDir), 0.0), 88.0);
    float sparkleLine = smoothstep(0.58, 1.08, fineA * 0.16 + fineB * 0.12 + fineC * 0.08);
    float brokenSparkle = step(0.91, waterNoise(p,1.0/1.35,0));
    float lineEnergy = clamp(fineA * 0.05 + fineB * 0.04 + fineC * 0.03, 0.0, 1.0);
    if (layer == 20.0) {
      color = texel.rgb * (0.72 + ripple * 0.22);
      color += uSunColor * (specular * 0.18 + sharpSpecular * 0.34);
      texel.a = 0.84;
    } else {
      float waterKind = layer == 18.0 ? 0.20 : layer == 19.0 ? 0.34 : 0.78;
      float waterDepthBase = clamp((vAo - 0.58) / 0.40, 0.0, 1.0);
      float depthFeather = (waterNoise(p,1.0/0.42,1) - 0.5) * 0.030;
      float waterDepth = clamp(waterDepthBase + depthFeather * (1.0 - smoothstep(0.88, 1.0, waterDepthBase)), 0.0, 1.0);
      float largePatch = smoothstep(0.20, 0.82, waterNoise(p,1.0/0.038,2));
      float smoothWaterDepth = smoothstep(0.0, 1.0, waterDepth);
      float depth = clamp(smoothWaterDepth * 0.84 + distanceFactor * 0.055 + largePatch * 0.025, 0.0, 1.0);
      float shoreBlend = 1.0 - smoothstep(0.02, 0.78, waterDepth);
      vec3 shoreBlue = vec3(0.56, 0.91, 0.97);
      vec3 clearBlue = vec3(0.12, 0.69, 0.94);
      vec3 seaBlue = vec3(0.025, 0.43, 0.84);
      vec3 deepBlue = vec3(0.018, 0.29, 0.70);
      vec3 depthTint = mix(mix(shoreBlue, clearBlue, waterKind), mix(seaBlue, deepBlue, distanceFactor * 0.48), depth);
      depthTint = mix(depthTint, shoreBlue, shoreBlend * (0.14 + (1.0 - distanceFactor) * 0.07));
      vec3 causticTint = mix(vec3(0.70, 1.02, 1.28), vec3(1.08, 1.04, 0.86), ripple * 0.18 + shoreBlend * 0.10);
      color = depthTint;
      color *= mix(vec3(0.86, 1.00, 1.12), causticTint, 0.09 + ripple * 0.07 + lineEnergy * 0.06);
      color += uSunColor * (specular * 0.12 + sharpSpecular * 0.28 + sunTrail * sparkleLine * brokenSparkle * 0.04);
      color += vec3(0.33, 0.74, 0.98) * lineEnergy * (0.08 + shoreBlend * 0.08) * (0.55 + (1.0 - distanceFactor) * 0.28);
      color += vec3(0.34, 0.70, 0.96) * shoreBlend * 0.035;
      color += vec3(0.16, 0.44, 0.78) * sunTrail * (0.014 + distanceFactor * 0.026);
      float cleanWater = 1.0 - step(17.5, layer);
      float edgeSparkleBand = 1.0 - smoothstep(0.045, 0.165, waterDepth);
      float tailSparkleBand = 1.0 - smoothstep(0.18, 0.94, waterDepth);
      float sparkleFalloff = edgeSparkleBand * 0.78 + tailSparkleBand * 0.22;
      float viewSparkleFade = 1.0 - smoothstep(0.70, 1.0, distanceFactor);
      float smallSparkleDensity = clamp(0.003 + tailSparkleBand * 0.007 + edgeSparkleBand * 0.052, 0.0, 0.08);
      float wideSparkleDensity = clamp(0.002 + tailSparkleBand * 0.005 + edgeSparkleBand * 0.020, 0.0, 0.034);
      float sparkleCells = waterSparkleCell(p, 0.52, smallSparkleDensity, 43.0, 3)
        + waterSparkleCell(p + vec2(19.0, -11.0), 0.86, wideSparkleDensity, 87.0, 4) * 0.82
        + waterSparkleCell(p + vec2(-7.0, 23.0), 1.42, 0.002 + tailSparkleBand * 0.003 + edgeSparkleBand * 0.009, 131.0, 5) * 0.42;
      float sparkleGlow = clamp(sparkleCells * cleanWater * viewSparkleFade * (0.82 + sunTrail * 0.72 + sharpSpecular * 0.18) * (0.76 + ripple * 0.14), 0.0, 0.72);
      float sparkleCore = pow(clamp(sparkleGlow, 0.0, 1.0), 1.28);
      float sparkleHalo = sparkleGlow * (0.22 + edgeSparkleBand * 0.38 + tailSparkleBand * 0.18);
      color += vec3(0.30, 0.82, 1.00) * sparkleHalo * 0.10;
      color += vec3(1.14, 1.04, 0.72) * sparkleCore * (0.22 + sharpSpecular * 0.24 + sunTrail * 0.14);
      color += vec3(0.78, 0.96, 1.00) * sparkleGlow * (edgeSparkleBand * 0.036 + tailSparkleBand * 0.012);
      waterGlareCore = sparkleCore * sparkleFalloff * viewSparkleFade * cleanWater;
      waterGlareHalo = sparkleHalo * viewSparkleFade * cleanWater;
      color = min(color, vec3(1.24, 1.25, 1.20));
      texel.a = mix(0.60, 0.82, distanceFactor) + ripple * 0.03 + clamp(sparkleGlow, 0.0, 1.0) * 0.030;
    }
    if (isWaterUnderside) {
      vec3 undersideTint = layer == 18.0
        ? vec3(0.13, 0.39, 0.35)
        : layer == 19.0
          ? vec3(0.17, 0.46, 0.29)
          : vec3(0.08, 0.44, 0.57);
      color = mix(color * vec3(0.74, 0.92, 0.98), undersideTint, 0.32 + ripple * 0.05);
      color += vec3(0.12, 0.36, 0.42) * lineEnergy * 0.20;
      texel.a = min(texel.a, 0.50 + ripple * 0.025);
      waterGlareCore = 0.0;
      waterGlareHalo = 0.0;
    }
  }
#endif
  color *= uLightParams.w;
  color = animeGrade(color);
  if (isWaterSurface && !isWaterUnderside) {
    float glareCore = smoothstep(0.22, 0.82, waterGlareCore);
    float glareHalo = smoothstep(0.08, 0.68, waterGlareHalo);
    color += vec3(0.34, 0.74, 1.00) * glareHalo * 0.12;
    color += vec3(1.35, 1.22, 0.78) * glareCore * 0.24;
    color = mix(color, vec3(1.0, 0.985, 0.82), glareCore * 0.24);
    color = min(color, vec3(1.34, 1.30, 1.18));
  }
  float viewLength = max(length(vViewPosition-uCameraLocalEye), 0.001);
  float horizonAngle = 1.0 - smoothstep(0.025, 0.145, abs(vViewPosition.y-uCameraLocalEye.y) / viewLength);
  float horizonDistance = smoothstep(uFogNearFar.x * 0.60, uFogNearFar.y * 0.96, length(vViewPosition.xz-uCameraLocalEye.xz));
  float horizonHaze = clamp(horizonAngle * horizonDistance, 0.0, 1.0);
  vec3 horizonFog = mix(uFogColor, uSkyLightColor, 0.28);
  color = mix(color, horizonFog, horizonHaze * 0.42);
  if (isWaterSurface && !isWaterUnderside) {
    texel.a = mix(texel.a, min(texel.a, 0.42), horizonHaze * 0.56);
    color = mix(color, horizonFog, horizonHaze * 0.24);
  }
  if (uUnderwater > 0.001 && !isWaterSurface) {
    float absorptionDistance = smoothstep(0.0, max(1.0, uFogNearFar.y), vFogDepth);
    float absorption = uUnderwater * mix(0.05, 0.20, absorptionDistance);
    vec3 absorbedColor = color * vec3(0.82, 0.95, 0.97) + vec3(0.025, 0.090, 0.105);
    color = mix(color, absorbedColor, absorption);
  }
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vFogDepth);
  color = mix(color, uFogColor, fog);
  outColor = vec4(color, texel.a * uOpacity);
}
`;

// Material partitions guarantee that the opaque/cutout/shadow passes contain
// no fluid. Compile that contract into their shader instead of carrying the
// complete water noise program through every terrain fragment.
export const SOLID_FRAGMENT_SHADER = OPAQUE_FRAGMENT_SHADER.replace(
  '#version 300 es', '#version 300 es\n#define NICECHUNK_SOLID_PASS 1',
);

export function createProgram(gl, vertexSource, fragmentSource) {
  let vertex = null;
  let fragment = null;
  let program = null;
  let linked = false;
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new Error("WebGL2 program allocation failed.");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Unknown WebGL2 program link error.");
    }
    linked = true;
    return program;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (program && !linked) gl.deleteProgram(program);
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 shader allocation failed.");
  let compiled = false;
  try {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Unknown WebGL2 shader compile error.");
    }
    compiled = true;
    return shader;
  } finally {
    if (!compiled) gl.deleteShader(shader);
  }
}
