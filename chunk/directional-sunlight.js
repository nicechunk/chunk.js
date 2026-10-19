import { isOpaqueSolidBlock } from "../world/block-registry.js";
import { WORLD_SUN_VECTOR, SUNLIGHT_HORIZONTAL_REACH } from "../world/sunlight.js";

const horizontal = Math.hypot(WORLD_SUN_VECTOR[0], WORLD_SUN_VECTOR[2]);
const direction = WORLD_SUN_VECTOR.map(value => value / horizontal);
// Every sample starts at an air-cell centre. Its exact voxel traversal is a
// translation of this one immutable path, including one-cell walls and roofs.
const path = createRayPath();

export function createDirectionalSunlight(access) {
  const columns = new Map(), solids = new Map();
  const stats = { rays: 0, cells: 0, blockQueries: 0, columnQueries: 0 };
  const topAt = (x, z) => {
    const key = `${x}:${z}`;
    if (!columns.has(key)) {
      columns.set(key, access.getColumnTopAtWorld(x, z));
      stats.columnQueries++;
    }
    return columns.get(key);
  };
  const sample = (x, y, z) => {
    stats.rays++;
    let skyAtEnd = false;
    for (const [dx, dy, dz] of path) {
      const cx = x + dx, cy = y + dy, cz = z + dz;
      stats.cells++;
      skyAtEnd = cy > topAt(cx, cz);
      if (skyAtEnd) continue;
      const key = `${cx}:${cy}:${cz}`;
      if (!solids.has(key)) {
        solids.set(key, isOpaqueSolidBlock(access.getBlockAtWorld(cx, cy, cz)));
        stats.blockQueries++;
      }
      if (solids.get(key)) return 0;
    }
    // A finite trace still under a ceiling is not open sky. Diffuse skylight
    // keeps its separate vertical seeds and finite six-neighbour transport.
    return skyAtEnd ? 15 : 0;
  };
  return { sample, stats };
}

function createRayPath() {
  const cell = [0, 0, 0], offsets = [[...cell]];
  const delta = direction.map(value => 1 / Math.abs(value));
  const next = delta.map(value => value / 2);
  while (true) {
    const distance = Math.min(...next);
    if (distance > SUNLIGHT_HORIZONTAL_REACH) break;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(next[axis] - distance) > 1e-10) continue;
      cell[axis] += Math.sign(direction[axis]);
      next[axis] += delta[axis];
    }
    offsets.push([...cell]);
  }
  return offsets;
}
