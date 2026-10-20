import { decodeNcf1, forgeCodeToBytes } from "./forge-core.js";

export const CONTAINER_RULE_VERSION = 1;
const SCALE = 2048;
const GRID = [14, 10, 14];
const MAX_CELLS = 65534;
const cache = new Map();
const tangentAxes = (axis) => axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
const mm3 = (q3) => Number(BigInt(q3) * 1_000_000_000n / 8_589_934_592n);
const at = (dims, x, y, z) => x + dims[0] * (y + dims[1] * z);

/** Preview only. Only capacity certified in the immutable chain item is usable. */
export function analyzeForgeContainer(input, { seedIndex = null } = {}) {
  const bytes = forgeCodeToBytes(input);
  const key = `${seedIndex ?? "auto"}:${Array.from(bytes).join(",")}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  try {
    const design = decodeNcf1(bytes, { requireCanonical: true });
    const geometry = design.appearance ? appearanceGeometry(design) : componentGeometry(design);
    const grip = validateGrip(geometry);
    if (!grip.valid) result = { valid: false, reason: grip.reason, capacityMl: 0 };
    else {
      const seeds = seedIndex === null ? openingCandidates(geometry) : [Number(seedIndex)];
      result = { valid: false, reason: "no-opening", capacityMl: 0 };
      for (const seed of seeds) {
        const candidate = certifyCavity(geometry, grip, seed);
        if (candidate.valid && (!result.valid || candidate.volumeQ3 > result.volumeQ3
          || (candidate.volumeQ3 === result.volumeQ3 && seed < result.seedIndex))) result = candidate;
      }
      if (result.valid) result = { ...result, ruleVersion: CONTAINER_RULE_VERSION,
        capacityMl: Math.floor(mm3(result.volumeQ3) / 1000), materialVolumeMm3: mm3(materialVolume(geometry)),
        gridDims: [...geometry.dims] };
    }
  } catch (error) {
    result = { valid: false, reason: error?.code || "invalid-geometry", capacityMl: 0 };
  }
  result = Object.freeze(result);
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

export function formatContainerCapacity(capacityMl) {
  const value = Math.max(0, Math.floor(Number(capacityMl) || 0));
  return value >= 1000 ? `${Number((value / 1000).toFixed(3))} L` : `${value} mL`;
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function makeGeometry(axisSets, grips) {
  const axes = axisSets.map((set) => {
    const values = [...set].sort((a, b) => a - b);
    if (values.length < 2) fail("empty-geometry");
    values.unshift(values[0] - 1); values.push(values.at(-1) + 1);
    if (values.length > 63) fail("container-too-complex");
    return values;
  });
  const dims = axes.map((axis) => axis.length - 1);
  if (dims.reduce((a, b) => a * b, 1) > MAX_CELLS) fail("container-too-complex");
  return { axes, dims, grips, material: new Uint8Array(dims.reduce((a, b) => a * b, 1)),
    gripMaterial: new Uint8Array(dims.reduce((a, b) => a * b, 1)),
    indexes: axes.map((axis) => new Map(axis.map((value, index) => [value, index]))) };
}

function componentGeometry(design) {
  const axes = [new Set(), new Set(), new Set()], boxes = [], grips = [];
  for (const c of design.components) {
    if (c.resource > 4) fail("unsupported-container-material");
    if (c.grip) grips.push({ ...c.grip, point: c.grip.offsetQ.map((v, a) => (v + c.offsetQ[a]) * 32) });
    const boundary = (a, p) => c.offsetQ[a] * 32 - c.dimsQ[a] * 16 + Math.floor((p * c.dimsQ[a] * 32 + GRID[a] / 2) / GRID[a]);
    const planes = [new Set(), new Set(), new Set()];
    const solid = (x, y, z) => x >= 0 && x < 14 && y >= 0 && y < 10 && z >= 0 && z < 14 && c.solid[x + 14 * (y + 10 * z)];
    for (let z = 0; z < 14; z++) for (let y = 0; y < 10; y++) for (let x = 0; x < 14; x++) {
      if (!solid(x, y, z)) continue;
      const p = [x, y, z];
      for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
        const q = [...p]; q[a] += side;
        if (!solid(...q)) planes[a].add(p[a] + (side > 0 ? 1 : 0));
      }
    }
    const cuts = planes.map((set, a) => [...set].sort((a, b) => a - b).map((p) => { axes[a].add(boundary(a, p)); return p; }));
    for (let zi = 0; zi + 1 < cuts[2].length; zi++) for (let yi = 0; yi + 1 < cuts[1].length; yi++) for (let xi = 0; xi + 1 < cuts[0].length; xi++) {
      const low = [cuts[0][xi], cuts[1][yi], cuts[2][zi]], high = [cuts[0][xi + 1], cuts[1][yi + 1], cuts[2][zi + 1]];
      if (solid(...low)) boxes.push({ low: low.map((p, a) => boundary(a, p)), high: high.map((p, a) => boundary(a, p)), gripOwner: Boolean(c.grip) });
    }
  }
  const g = makeGeometry(axes, grips);
  for (const box of boxes) {
    const low = box.low.map((v, a) => g.indexes[a].get(v)), high = box.high.map((v, a) => g.indexes[a].get(v));
    for (let z = low[2]; z < high[2]; z++) for (let y = low[1]; y < high[1]; y++) for (let x = low[0]; x < high[0]; x++) {
      const index = at(g.dims, x, y, z);
      g.material[index] = 1;
      if (box.gripOwner) g.gripMaterial[index] = 1;
    }
  }
  return g;
}

function appearanceGeometry(design) {
  const app = design.appearance, axes = [new Set(), new Set(), new Set()];
  const boundary = (a, p) => -app.dimsQ[a] * 16 + Math.floor((p * app.dimsQ[a] * 32 + 12) / 24);
  for (const q of app.quads) {
    if (q.resource > 4) fail("unsupported-container-material");
    const t = tangentAxes(q.axis);
    axes[q.axis].add(boundary(q.axis, q.plane));
    [q.u0, q.u1].forEach((p) => axes[t[0]].add(boundary(t[0], p)));
    [q.v0, q.v1].forEach((p) => axes[t[1]].add(boundary(t[1], p)));
  }
  const g = makeGeometry(axes, app.grip ? [{ ...app.grip, point: app.grip.offsetQ.map((v) => v * 32) }] : []);
  const faces = new Map();
  const faceKey = (a, p, u, v) => `${a}:${p}:${u}:${v}`;
  for (const q of app.quads) {
    const t = tangentAxes(q.axis), plane = g.indexes[q.axis].get(boundary(q.axis, q.plane));
    const low = [g.indexes[t[0]].get(boundary(t[0], q.u0)), g.indexes[t[1]].get(boundary(t[1], q.v0))];
    const high = [g.indexes[t[0]].get(boundary(t[0], q.u1)), g.indexes[t[1]].get(boundary(t[1], q.v1))];
    for (let v = low[1]; v < high[1]; v++) for (let u = low[0]; u < high[0]; u++) {
      const key = faceKey(q.axis, plane, u, v);
      if (faces.has(key)) fail("invalid-container-surface");
      faces.set(key, q.side + 1);
    }
  }
  const [nx, ny, nz] = g.dims;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
    let inside = false;
    for (let x = 0; x <= nx; x++) {
      const face = faces.get(faceKey(0, x, y, z)) || 0;
      if (face === 1) { if (inside) fail("invalid-container-surface"); inside = true; }
      if (face === 2) { if (!inside) fail("invalid-container-surface"); inside = false; }
      if (x < nx && inside) g.material[at(g.dims, x, y, z)] = 1;
    }
    if (inside) fail("invalid-container-surface");
  }
  const strides = [1, nx, nx * ny];
  for (let a = 0; a < 3; a++) {
    const t = tangentAxes(a);
    for (let v = 0; v < g.dims[t[1]]; v++) for (let u = 0; u < g.dims[t[0]]; u++) for (let p = 0; p <= g.dims[a]; p++) {
      const point = [0, 0, 0]; point[a] = p; point[t[0]] = u; point[t[1]] = v;
      const index = at(g.dims, ...point);
      const left = p > 0 && Boolean(g.material[index - strides[a]]), right = p < g.dims[a] && Boolean(g.material[index]);
      const expected = left === right ? 0 : left ? 2 : 1;
      if ((faces.get(faceKey(a, p, u, v)) || 0) !== expected) fail("invalid-container-surface");
    }
  }
  g.gripMaterial.set(g.material);
  return g;
}

function validateGrip(g) {
  if (g.grips.length !== 1) return { valid: false, reason: "invalid-grip" };
  const grip = g.grips[0], a = grip.axis, t = tangentAxes(a), [nx, ny, nz] = g.dims;
  const palm = grip.rotation & 1 ? [204, 163] : [163, 204], strides = [1, nx, nx * ny];
  let contact = 0, surface = 0, cell = -1;
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = [x, y, z], index = at(g.dims, x, y, z);
    // Measure only the bound component; test exposure against the whole union.
    if (!g.gripMaterial[index] || Math.abs(g.axes[a][p[a] + (grip.sign > 0 ? 1 : 0)] - grip.point[a]) > 16) continue;
    const edge = grip.sign > 0 ? p[a] + 1 === g.dims[a] : p[a] === 0;
    if (!edge && g.material[index + (grip.sign > 0 ? strides[a] : -strides[a])]) continue;
    const widths = t.map((axis, i) => {
      const lo = g.axes[axis][p[axis]], hi = g.axes[axis][p[axis] + 1];
      min[i] = Math.min(min[i], lo); max[i] = Math.max(max[i], hi);
      const half = Math.floor(palm[i] / 2);
      return Math.max(0, Math.min(hi, grip.point[axis] + half) - Math.max(lo, grip.point[axis] - half));
    });
    surface += width(g, t[0], p[t[0]]) * width(g, t[1], p[t[1]]);
    if (widths.every((v) => v > 0)) { contact += widths[0] * widths[1]; cell = index; }
  }
  if (cell < 0 || contact * 1_000_000 < 25 * SCALE * SCALE || contact * 100 < Math.min(surface, palm[0] * palm[1]) * 18
    || Math.min(max[0] - min[0], max[1] - min[1]) > 205) return { valid: false, reason: "invalid-grip" };
  const connected = new Uint8Array(g.material.length), queue = [cell]; connected[cell] = 1;
  for (let i = 0; i < queue.length; i++) for (const n of neighbors(g, queue[i])) if (g.material[n] && !connected[n]) { connected[n] = 1; queue.push(n); }
  return { valid: true, connected };
}

function openingCandidates(g) {
  const [nx, ny, nz] = g.dims, results = new Set();
  for (let y = ny - 2; y >= 0; y--) {
    const seen = new Uint8Array(nx * nz);
    for (let z = 1; z + 1 < nz; z++) for (let x = 1; x + 1 < nx; x++) {
      const seed = x + nx * z;
      if (seen[seed] || g.material[at(g.dims, x, y, z)]) continue;
      const patch = planeRegion(g, y, x, z);
      patch.cells.forEach((p) => { seen[p] = 1; });
      if (patch.bounded && patch.visible) results.add(x | z << 6);
    }
  }
  return [...results];
}

function planeRegion(g, y, sx, sz) {
  const [nx, ny, nz] = g.dims, seen = new Uint8Array(nx * nz), cells = [sx + nx * sz];
  seen[cells[0]] = 1; let bounded = true, visible = true;
  for (let i = 0; i < cells.length; i++) {
    const x = cells[i] % nx, z = Math.floor(cells[i] / nx);
    if (!x || x + 1 === nx || !z || z + 1 === nz) bounded = false;
    for (let top = y + 1; top < ny; top++) if (g.material[at(g.dims, x, top, z)]) visible = false;
    for (const [xx, zz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
      const n = xx + nx * zz;
      if (xx < 0 || xx >= nx || zz < 0 || zz >= nz || seen[n] || g.material[at(g.dims, xx, y, zz)]) continue;
      seen[n] = 1; cells.push(n);
    }
  }
  return { cells, mask: seen, bounded, visible };
}

function certifyCavity(g, grip, seedIndex) {
  const [nx, ny, nz] = g.dims, sx = seedIndex & 63, sz = seedIndex >> 6 & 63;
  if (seedIndex & 0xf000 || sx >= nx || sz >= nz) return { valid: false, reason: "invalid-seed", capacityMl: 0 };
  let mouth = -1, opening;
  for (let y = ny - 2; y >= 0; y--) {
    if (g.material[at(g.dims, sx, y, sz)]) break;
    const patch = planeRegion(g, y, sx, sz);
    if (patch.bounded && patch.visible) { mouth = y; opening = patch; break; }
  }
  if (mouth < 0) return { valid: false, reason: "no-opening", capacityMl: 0 };
  const seen = new Uint8Array(g.material.length), queue = [at(g.dims, sx, mouth, sz)]; seen[queue[0]] = 1;
  let volumeQ3 = 0;
  for (let i = 0; i < queue.length; i++) {
    const index = queue[i], x = index % nx, yz = Math.floor(index / nx), y = yz % ny, z = Math.floor(yz / ny);
    if (!x || x + 1 === nx || !y || y + 1 === ny || !z || z + 1 === nz) return { valid: false, reason: "leaking-cavity", capacityMl: 0 };
    volumeQ3 += width(g, 0, x) * width(g, 1, y) * width(g, 2, z);
    for (const n of neighbors(g, index)) {
      if (g.material[n]) { if (!grip.connected[n]) return { valid: false, reason: "detached-grip", capacityMl: 0 }; continue; }
      const cap = ((n === index + nx && y === mouth) || (n === index - nx && y === mouth + 1)) && opening.mask[x + nx * z];
      if (!cap && !seen[n]) { seen[n] = 1; queue.push(n); }
    }
  }
  const openingQuads = opening.cells.map((index) => {
    const x = index % nx, z = Math.floor(index / nx);
    return Object.freeze({ min: [g.axes[0][x] / SCALE, g.axes[1][mouth + 1] / SCALE, g.axes[2][z] / SCALE],
      max: [g.axes[0][x + 1] / SCALE, g.axes[1][mouth + 1] / SCALE, g.axes[2][z + 1] / SCALE] });
  });
  return { valid: true, reason: "valid", seedIndex, volumeQ3, openingQuads: Object.freeze(openingQuads) };
}

function neighbors(g, index) {
  const [nx, ny, nz] = g.dims, x = index % nx, yz = Math.floor(index / nx), y = yz % ny, z = Math.floor(yz / ny), out = [];
  if (x > 0) out.push(index - 1); if (x + 1 < nx) out.push(index + 1);
  if (y > 0) out.push(index - nx); if (y + 1 < ny) out.push(index + nx);
  if (z > 0) out.push(index - nx * ny); if (z + 1 < nz) out.push(index + nx * ny);
  return out;
}
function width(g, axis, p) { return g.axes[axis][p + 1] - g.axes[axis][p]; }
function materialVolume(g) {
  const [nx, ny, nz] = g.dims; let volume = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (g.material[at(g.dims, x, y, z)]) volume += width(g, 0, x) * width(g, 1, y) * width(g, 2, z);
  return volume;
}
