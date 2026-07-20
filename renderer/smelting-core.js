const DEFAULT_MAX_PIXEL_RATIO = 1.25;

const VERTEX_SOURCE = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uIntensity;
uniform float uHeatTier;
uniform float uProgress;
uniform float uRunning;

float saturate(float value) {
  return clamp(value, 0.0, 1.0);
}

float hash12(vec2 value) {
  vec3 p3 = fract(vec3(value.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 value) {
  vec2 base = floor(value);
  vec2 f = fract(value);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(base + vec2(0.0, 0.0));
  float b = hash12(base + vec2(1.0, 0.0));
  float c = hash12(base + vec2(0.0, 1.0));
  float d = hash12(base + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 heatColor(float heatTier, float pulse) {
  vec3 coal = vec3(0.98, 0.34, 0.08);
  vec3 gold = vec3(1.0, 0.72, 0.22);
  vec3 white = vec3(1.0, 0.94, 0.72);
  vec3 cyan = vec3(0.35, 0.92, 1.0);
  float hot = saturate((heatTier - 1.0) / 4.0);
  vec3 warm = mix(coal, gold, saturate(heatTier / 2.8));
  vec3 bright = mix(warm, white, hot * 0.52 + pulse * 0.10);
  return mix(bright, cyan, hot * 0.18);
}

void main() {
  vec2 uv = vUv;
  vec2 p = uv * 2.0 - 1.0;
  float aspect = max(0.25, uResolution.x / max(1.0, uResolution.y));
  p.x *= aspect;

  float safeIntensity = clamp(uIntensity, 0.025, 1.25);
  float running = step(0.5, uRunning);
  float heat = max(0.0, uHeatTier);
  float progress = saturate(uProgress);
  float time = uTime;

  float pulse = 0.5 + 0.5 * sin(time * (1.45 + safeIntensity * 1.6) + progress * 3.14159);
  float swirl = atan(p.y, p.x) + time * (0.22 + safeIntensity * 0.68);
  float radius = length(p);
  float flameNoise = valueNoise(vec2(swirl * 1.7 + time * 0.22, radius * 4.4 - time * 0.58));

  float coreRadius = 0.46 + safeIntensity * 0.08 + pulse * 0.018;
  float shellRadius = 0.62 + safeIntensity * 0.12;
  float sphere = smoothstep(coreRadius + 0.035, coreRadius - 0.018, radius);
  float shell = smoothstep(shellRadius + 0.08, shellRadius - 0.03, radius) * (1.0 - sphere * 0.32);
  float halo = smoothstep(1.08 + safeIntensity * 0.14, 0.36, radius) * (0.12 + safeIntensity * 0.24);

  vec3 normal = normalize(vec3(p / max(0.001, coreRadius), sqrt(max(0.0, 1.0 - radius * radius / max(0.001, coreRadius * coreRadius)))));
  vec3 lightDir = normalize(vec3(-0.55, 0.74, 0.85));
  float diffuse = saturate(dot(normal, lightDir)) * 0.68 + 0.34;
  float rim = pow(saturate(1.0 - normal.z), 2.0) * (0.22 + safeIntensity * 0.42);
  float hotSpot = pow(saturate(dot(normal, normalize(vec3(0.46, -0.18, 0.88)))), 24.0) * (0.20 + safeIntensity * 0.54);

  vec3 coreColor = heatColor(heat, pulse);
  vec3 darkGlass = vec3(0.16, 0.05, 0.025);
  vec3 color = mix(darkGlass, coreColor, sphere * (0.62 + safeIntensity * 0.34));
  color *= diffuse;
  color += coreColor * (rim + hotSpot + sphere * safeIntensity * 0.28);

  float flame = shell * (0.20 + safeIntensity * 0.45) * (0.74 + flameNoise * 0.48 + pulse * 0.16);
  color += mix(vec3(1.0, 0.22, 0.04), vec3(1.0, 0.85, 0.34), flameNoise) * flame;
  color += coreColor * halo;

  float emberSum = 0.0;
  vec3 emberColor = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float fi = float(i);
    vec2 seed = vec2(fi * 17.13 + 4.7, fi * 9.41 + 1.9);
    float lane = hash12(seed);
    float spin = mix(-1.0, 1.0, hash12(seed + 5.0));
    float angle = lane * 6.28318 + time * (0.24 + hash12(seed + 11.0) * 0.52) * spin;
    float orbit = 0.52 + hash12(seed + 17.0) * 0.42;
    float lift = fract(hash12(seed + 23.0) + time * (0.08 + safeIntensity * 0.24) + progress * 0.36);
    vec2 emberPos = vec2(cos(angle) * orbit / aspect, mix(-0.78, 0.88, lift));
    emberPos.x += sin(time * 0.9 + fi) * 0.045;
    float size = mix(0.018, 0.042, hash12(seed + 31.0)) * (0.75 + safeIntensity * 0.55);
    float d = length((uv * 2.0 - 1.0) - emberPos);
    float fade = smoothstep(1.0, 0.66, lift) * smoothstep(0.02, 0.26, lift);
    float ember = smoothstep(size, 0.0, d) * fade * (0.12 + safeIntensity * 0.82) * (0.55 + running * 0.45);
    emberSum += ember;
    emberColor += mix(vec3(1.0, 0.30, 0.04), vec3(1.0, 0.92, 0.58), hash12(seed + 41.0)) * ember;
  }

  color += emberColor;
  float alpha = saturate(sphere * 0.82 + shell * 0.36 + halo * 0.72 + emberSum * 0.82);
  float vignette = smoothstep(1.35, 0.38, length(p));
  alpha *= 0.62 + vignette * 0.38;
  color *= 0.48 + safeIntensity * 0.62 + running * 0.16;

  outColor = vec4(color, alpha);
}
`;

export function createSmeltingCoreRenderer(containerOrCanvas, options = {}) {
  const target = containerOrCanvas;
  if (!target || typeof document === "undefined") return null;

  const canvas = target instanceof HTMLCanvasElement
    ? target
    : target.querySelector?.("canvas[data-nicechunk-smelting-core]") || document.createElement("canvas");
  if (!(target instanceof HTMLCanvasElement)) {
    canvas.className = options.className || "smelting-core-canvas";
    canvas.dataset.nicechunkSmeltingCore = "true";
    if (canvas.parentNode !== target) target.prepend(canvas);
  }

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  const program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
  if (!program) return null;

  const buffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  const positionLocation = gl.getAttribLocation(program, "aPosition");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const uniforms = {
    resolution: gl.getUniformLocation(program, "uResolution"),
    time: gl.getUniformLocation(program, "uTime"),
    intensity: gl.getUniformLocation(program, "uIntensity"),
    heatTier: gl.getUniformLocation(program, "uHeatTier"),
    progress: gl.getUniformLocation(program, "uProgress"),
    running: gl.getUniformLocation(program, "uRunning"),
  };

  const state = {
    disposed: false,
    maxPixelRatio: finiteNumber(options.maxPixelRatio, DEFAULT_MAX_PIXEL_RATIO),
    lastWidth: 0,
    lastHeight: 0,
  };

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    canvas,
    render(params = {}) {
      if (state.disposed) return false;
      resizeCanvas(canvas, gl, state);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      const timeMs = finiteNumber(params.timeMs, typeof performance !== "undefined" ? performance.now() : 0);
      const progress = clamp01(params.progress ?? 0);
      const heatTier = Math.max(0, finiteNumber(params.heatTier, 0));
      const baseIntensity = finiteNumber(params.intensity, 0.08);
      const running = params.running ? 1 : 0;
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, timeMs * 0.001);
      gl.uniform1f(uniforms.intensity, Math.max(0.025, Math.min(1.25, baseIntensity)));
      gl.uniform1f(uniforms.heatTier, heatTier);
      gl.uniform1f(uniforms.progress, progress);
      gl.uniform1f(uniforms.running, running);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      return true;
    },
    resize() {
      if (state.disposed) return false;
      return resizeCanvas(canvas, gl, state);
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      if (!(target instanceof HTMLCanvasElement) && canvas.parentNode === target) canvas.remove();
    },
  };
}

function resizeCanvas(canvas, gl, state) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width || canvas.clientWidth || 240));
  const cssHeight = Math.max(1, Math.floor(rect.height || canvas.clientHeight || 180));
  const pixelRatio = Math.max(1, Math.min(state.maxPixelRatio, globalThis.devicePixelRatio || 1));
  const width = Math.max(1, Math.floor(cssWidth * pixelRatio));
  const height = Math.max(1, Math.floor(cssHeight * pixelRatio));
  if (canvas.width === width && canvas.height === height && state.lastWidth === width && state.lastHeight === height) return false;
  canvas.width = width;
  canvas.height = height;
  state.lastWidth = width;
  state.lastHeight = height;
  gl.viewport(0, 0, width, height);
  return true;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("NiceChunk smelting core shader link failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("NiceChunk smelting core shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finiteNumber(value, 0)));
}
