import { MATERIAL_ID } from "../world/block-registry.js";
import { materialDefs } from "../world/material-registry.js";

/**
 * chunk.js — deterministic NiceChunk building codec.
 *
 * NCM3 stores canonical NiceChunk material IDs plus a small, bounded set of
 * declarative construction commands. It never evaluates code from the chain.
 * The same payload therefore expands to the same voxel map in every client.
 */

export const NCM3_PREFIX = "NCM3:";
export const NCM2_PREFIX = "NCM2:";
export const NCM3_MAX_PAYLOAD_BYTES = 65535;
export const NCM3_MAX_COMMANDS = 4_096;
export const NCM3_MAX_EXPANDED_OPERATIONS = 262_144;
export const NCM3_MAX_VOXELS = 131_072;
export const NCM3_MAX_DIMENSION = 256;

const NCM3_MAX_U32 = 0xffffffff;
const NCM_MAX_ENCODED_LENGTH = Math.ceil(NCM3_MAX_PAYLOAD_BYTES * 4 / 3);
const NCBP_HEADER_BYTES = 76;
const MAX_BLUEPRINT_ACCOUNT_BYTES = Math.max(
  NCBP_HEADER_BYTES + NCM3_MAX_PAYLOAD_BYTES,
  NCM3_PREFIX.length + NCM_MAX_ENCODED_LENGTH,
);

const NCM_INTERNAL_MATERIAL_KEYS = new Set(["air", "grassSide", "shadow"]);
const NCM_MATERIAL_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(MATERIAL_ID)
    .filter(([key, id]) => id > 0 && materialDefs[id] && !NCM_INTERNAL_MATERIAL_KEYS.has(key))
    .map(([key, id]) => [id, key]),
));

export const NCM_MATERIALS = Object.freeze(Object.fromEntries(
  Object.entries(NCM_MATERIAL_KEYS).map(([idText, key]) => {
    const id = Number(idText);
    const definition = materialDefs[id];
    const alpha = definition.baseColor[3] / 255;
    const transparent = definition.shaderType === "fluid" || definition.shaderType === "transparent";
    const emissive = definition.emissive.some((value) => value > 0)
      ? rgbBytesToHex(definition.emissive.map((value) => Math.round(value * 255)))
      : null;
    return [id, Object.freeze({
      id,
      key,
      name: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase()),
      color: rgbBytesToHex(definition.baseColor),
      style: definition.style,
      transparent,
      opacity: transparent ? alpha : 1,
      emissive,
    })];
  }),
));

// Backwards-compatible short alias for the first NCM3 consumers.
export const MATERIALS = NCM_MATERIALS;

const OPCODE = Object.freeze({ BOX: 1, REPEAT_BOX: 2, GABLE: 3, TREE: 4, FENCE: 5, GABLE_TRIM: 6, GABLE_FILL: 7, GABLE_Z: 8, GABLE_TRIM_Z: 9, GABLE_FILL_Z: 10 });
const OPCODE_NAME = Object.freeze(Object.fromEntries(Object.entries(OPCODE).map(([name, value]) => [value, name])));
const GABLE_OPS = new Set([OPCODE.GABLE, OPCODE.GABLE_TRIM, OPCODE.GABLE_FILL, OPCODE.GABLE_Z, OPCODE.GABLE_TRIM_Z, OPCODE.GABLE_FILL_Z]);

export class Blueprint {
  constructor(size, name = "Untitled") {
    this.size = normalizeSize(size);
    this.name = name;
    this.commands = [];
  }

  box(material, x, y, z, w = 1, h = 1, d = 1) {
    this.commands.push({ op: OPCODE.BOX, material, x, y, z, w, h, d });
    return this;
  }

  repeat(material, x, y, z, w, h, d, count, dx = 0, dy = 0, dz = 0) {
    this.commands.push({ op: OPCODE.REPEAT_BOX, material, x, y, z, w, h, d, count, dx, dy, dz });
    return this;
  }

  gable(material, x, y, z, width, depth) {
    this.commands.push({ op: OPCODE.GABLE, material, x, y, z, width, depth });
    return this;
  }

  tree(trunkMaterial, leafMaterial, x, y, z, height = 8, crownRadius = 3) {
    this.commands.push({ op: OPCODE.TREE, trunkMaterial, leafMaterial, x, y, z, height, crownRadius });
    return this;
  }

  fence(material, x, y, z, length, axis = 0, spacing = 4) {
    this.commands.push({ op: OPCODE.FENCE, material, x, y, z, length, axis, spacing });
    return this;
  }

  gableTrim(material, x, y, z, width, depth) {
    this.commands.push({ op: OPCODE.GABLE_TRIM, material, x, y, z, width, depth });
    return this;
  }

  gableFill(material, x, y, z, width, depth = 1) {
    this.commands.push({ op: OPCODE.GABLE_FILL, material, x, y, z, width, depth });
    return this;
  }

  gableZ(material, x, y, z, width, depth) {
    this.commands.push({ op: OPCODE.GABLE_Z, material, x, y, z, width, depth });
    return this;
  }

  gableTrimZ(material, x, y, z, width, depth) {
    this.commands.push({ op: OPCODE.GABLE_TRIM_Z, material, x, y, z, width, depth });
    return this;
  }

  gableFillZ(material, x, y, z, width, depth) {
    this.commands.push({ op: OPCODE.GABLE_FILL_Z, material, x, y, z, width, depth });
    return this;
  }
}

export function createBlueprint(size, name) {
  return new Blueprint(size, name);
}

export function encodeNcm3(blueprint) {
  validateBlueprint(blueprint);
  const bytes = [1];
  writeVar(bytes, blueprint.size.x);
  writeVar(bytes, blueprint.size.y);
  writeVar(bytes, blueprint.size.z);
  writeVar(bytes, blueprint.commands.length);

  for (const command of blueprint.commands) {
    bytes.push(command.op);
    if (command.op === OPCODE.TREE) {
      writeMaterial(bytes, command.trunkMaterial);
      writeMaterial(bytes, command.leafMaterial);
      [command.x, command.y, command.z, command.height, command.crownRadius].forEach((value) => writeVar(bytes, value));
      continue;
    }

    writeMaterial(bytes, command.material);
    if (command.op === OPCODE.BOX) {
      [command.x, command.y, command.z, command.w - 1, command.h - 1, command.d - 1].forEach((value) => writeVar(bytes, value));
    } else if (command.op === OPCODE.REPEAT_BOX) {
      [command.x, command.y, command.z, command.w - 1, command.h - 1, command.d - 1, command.count - 1].forEach((value) => writeVar(bytes, value));
      [command.dx, command.dy, command.dz].forEach((value) => writeSignedVar(bytes, value));
    } else if (GABLE_OPS.has(command.op)) {
      [command.x, command.y, command.z, command.width - 1, command.depth - 1].forEach((value) => writeVar(bytes, value));
    } else if (command.op === OPCODE.FENCE) {
      [command.x, command.y, command.z, command.length - 1, command.axis, command.spacing].forEach((value) => writeVar(bytes, value));
    } else {
      throw new Error(`Unsupported command opcode ${command.op}.`);
    }
  }
  const raw = Uint8Array.from(bytes);
  if (raw.length > NCM3_MAX_PAYLOAD_BYTES) throw new Error("NCM3 payload exceeds the safety limit.");
  return `${NCM3_PREFIX}${base64UrlEncode(raw)}`;
}

export function decodeNcm3(code) {
  return decodeNcm3Record(code).blueprint;
}

/**
 * Decode and validate the bounded NCM3 command envelope without voxelizing it.
 * This is suitable for request/result preflight; overlapping writes still
 * require voxelization to establish the exact final voxel count/material set.
 */
export function analyzeNcm3Envelope(code) {
  const record = decodeNcm3Record(code);
  const { blueprint, analysis } = record;
  return Object.freeze({
    canonicalCode: record.text,
    payloadBytes: record.payloadBytes,
    name: blueprint.name,
    size: Object.freeze({ ...analysis.size }),
    commandCount: blueprint.commands.length,
    referencedMaterials: Object.freeze([...analysis.referencedMaterials]),
    operationUpperBound: analysis.operationUpperBound,
    maxVoxelCount: Math.min(
      NCM3_MAX_VOXELS,
      analysis.size.x * analysis.size.y * analysis.size.z,
      analysis.operationUpperBound,
    ),
    contentBounds: Object.freeze({ ...analysis.contentBounds }),
  });
}

function decodeNcm3Record(code) {
  const text = String(code ?? "");
  if (!text.startsWith(NCM3_PREFIX)) throw new Error("Expected an NCM3 payload.");
  const raw = decodeCanonicalPayload(text.slice(NCM3_PREFIX.length), "NCM3");
  const reader = createByteReader(raw);
  const version = reader.read();
  if (version !== 1) throw new Error(`Unsupported NCM3 version ${version}.`);
  const blueprint = new Blueprint({ x: readVar(reader), y: readVar(reader), z: readVar(reader) }, "PDA Blueprint");
  const commandCount = readVar(reader);
  if (commandCount > NCM3_MAX_COMMANDS) throw new Error("NCM3 command limit exceeded.");

  for (let index = 0; index < commandCount; index++) {
    const op = reader.read();
    if (op === OPCODE.TREE) {
      blueprint.commands.push({
        op,
        trunkMaterial: readMaterial(reader),
        leafMaterial: readMaterial(reader),
        x: readVar(reader), y: readVar(reader), z: readVar(reader),
        height: readVar(reader), crownRadius: readVar(reader),
      });
      continue;
    }

    const material = readMaterial(reader);
    if (op === OPCODE.BOX) {
      blueprint.commands.push({ op, material, x: readVar(reader), y: readVar(reader), z: readVar(reader), w: readVar(reader) + 1, h: readVar(reader) + 1, d: readVar(reader) + 1 });
    } else if (op === OPCODE.REPEAT_BOX) {
      blueprint.commands.push({
        op, material,
        x: readVar(reader), y: readVar(reader), z: readVar(reader),
        w: readVar(reader) + 1, h: readVar(reader) + 1, d: readVar(reader) + 1,
        count: readVar(reader) + 1,
        dx: readSignedVar(reader), dy: readSignedVar(reader), dz: readSignedVar(reader),
      });
    } else if (GABLE_OPS.has(op)) {
      blueprint.commands.push({ op, material, x: readVar(reader), y: readVar(reader), z: readVar(reader), width: readVar(reader) + 1, depth: readVar(reader) + 1 });
    } else if (op === OPCODE.FENCE) {
      blueprint.commands.push({ op, material, x: readVar(reader), y: readVar(reader), z: readVar(reader), length: readVar(reader) + 1, axis: readVar(reader), spacing: readVar(reader) });
    } else {
      throw new Error(`Unknown NCM3 opcode ${op}.`);
    }
  }
  if (!reader.done()) throw new Error("Unexpected trailing NCM3 bytes.");
  const analysis = validateBlueprint(blueprint);
  return { text, payloadBytes: raw.byteLength, blueprint, analysis };
}

export function expandBlueprint(blueprint) {
  validateBlueprint(blueprint);
  const cuboids = [];
  const add = (material, x, y, z, w = 1, h = 1, d = 1) => cuboids.push({ material, x, y, z, w, h, d });

  for (const command of blueprint.commands) {
    if (command.op === OPCODE.BOX) {
      add(command.material, command.x, command.y, command.z, command.w, command.h, command.d);
    } else if (command.op === OPCODE.REPEAT_BOX) {
      for (let index = 0; index < command.count; index++) {
        add(command.material, command.x + command.dx * index, command.y + command.dy * index, command.z + command.dz * index, command.w, command.h, command.d);
      }
    } else if (command.op === OPCODE.GABLE) {
      const layers = Math.ceil(command.width / 2);
      for (let layer = 0; layer < layers; layer++) {
        const left = command.x + layer;
        const right = command.x + command.width - 1 - layer;
        add(command.material, left, command.y + layer, command.z, 1, 1, command.depth);
        if (right !== left) add(command.material, right, command.y + layer, command.z, 1, 1, command.depth);
      }
    } else if (command.op === OPCODE.TREE) {
      const trunkHeight = Math.max(2, command.height - command.crownRadius);
      add(command.trunkMaterial, command.x, command.y, command.z, 2, trunkHeight, 2);
      for (let layer = 0; layer < command.crownRadius; layer++) {
        const radius = Math.max(1, command.crownRadius - Math.floor(layer / 2));
        add(command.leafMaterial, command.x - radius, command.y + trunkHeight - 1 + layer, command.z - 1, radius * 2 + 2, 1, 4);
        add(command.leafMaterial, command.x - 1, command.y + trunkHeight - 1 + layer, command.z - radius, 4, 1, radius * 2 + 2);
      }
      add(command.leafMaterial, command.x, command.y + command.height - 1, command.z, 2, 1, 2);
    } else if (command.op === OPCODE.FENCE) {
      const axisX = command.axis === 0;
      add(command.material, command.x, command.y + 1, command.z, axisX ? command.length : 1, 1, axisX ? 1 : command.length);
      add(command.material, command.x, command.y + 3, command.z, axisX ? command.length : 1, 1, axisX ? 1 : command.length);
      for (let offset = 0; offset < command.length; offset += Math.max(1, command.spacing)) {
        add(command.material, command.x + (axisX ? offset : 0), command.y, command.z + (axisX ? 0 : offset), 1, 5, 1);
      }
      const end = command.length - 1;
      add(command.material, command.x + (axisX ? end : 0), command.y, command.z + (axisX ? 0 : end), 1, 5, 1);
    } else if (command.op === OPCODE.GABLE_TRIM) {
      const layers = Math.ceil(command.width / 2);
      for (let layer = 0; layer < layers; layer++) {
        const left = command.x + layer;
        const right = command.x + command.width - 1 - layer;
        add(command.material, left, command.y + layer, command.z, 1, 1, 1);
        add(command.material, left, command.y + layer, command.z + command.depth - 1, 1, 1, 1);
        if (right !== left) {
          add(command.material, right, command.y + layer, command.z, 1, 1, 1);
          add(command.material, right, command.y + layer, command.z + command.depth - 1, 1, 1, 1);
        }
      }
    } else if (command.op === OPCODE.GABLE_FILL) {
      const layers = Math.ceil(command.width / 2);
      for (let layer = 0; layer < layers; layer++) {
        add(command.material, command.x + layer, command.y + layer, command.z, command.width - layer * 2, 1, command.depth);
      }
    } else if (command.op === OPCODE.GABLE_Z) {
      const layers = Math.ceil(command.depth / 2);
      for (let layer = 0; layer < layers; layer++) {
        const front = command.z + layer;
        const back = command.z + command.depth - 1 - layer;
        add(command.material, command.x, command.y + layer, front, command.width, 1, 1);
        if (back !== front) add(command.material, command.x, command.y + layer, back, command.width, 1, 1);
      }
    } else if (command.op === OPCODE.GABLE_TRIM_Z) {
      const layers = Math.ceil(command.depth / 2);
      for (let layer = 0; layer < layers; layer++) {
        const front = command.z + layer;
        const back = command.z + command.depth - 1 - layer;
        add(command.material, command.x, command.y + layer, front, 1, 1, 1);
        add(command.material, command.x + command.width - 1, command.y + layer, front, 1, 1, 1);
        if (back !== front) {
          add(command.material, command.x, command.y + layer, back, 1, 1, 1);
          add(command.material, command.x + command.width - 1, command.y + layer, back, 1, 1, 1);
        }
      }
    } else if (command.op === OPCODE.GABLE_FILL_Z) {
      const layers = Math.ceil(command.depth / 2);
      for (let layer = 0; layer < layers; layer++) {
        add(command.material, command.x, command.y + layer, command.z + layer, command.width, 1, command.depth - layer * 2);
      }
    }
  }
  return cuboids;
}

/** Later commands overwrite earlier commands, matching a deterministic paint stack. */
export function voxelize(blueprintOrCuboids, sizeOverride) {
  const blueprint = Array.isArray(blueprintOrCuboids) ? null : blueprintOrCuboids;
  const cuboids = blueprint ? expandBlueprint(blueprint) : blueprintOrCuboids;
  const size = blueprint ? blueprint.size : normalizeSize(sizeOverride);
  const voxels = new Map();
  let operationBudget = 0;
  for (const cuboid of cuboids) {
    validateCuboid(cuboid, size);
    operationBudget += cuboid.w * cuboid.h * cuboid.d;
    if (operationBudget > NCM3_MAX_EXPANDED_OPERATIONS) throw new Error("Expanded voxel operation budget exceeded.");
    for (let y = cuboid.y; y < cuboid.y + cuboid.h; y++) {
      for (let z = cuboid.z; z < cuboid.z + cuboid.d; z++) {
        for (let x = cuboid.x; x < cuboid.x + cuboid.w; x++) {
          voxels.set(`${x},${y},${z}`, { x, y, z, material: cuboid.material });
        }
      }
    }
  }
  if (voxels.size > NCM3_MAX_VOXELS) throw new Error("Expanded voxel safety limit exceeded.");
  return voxels;
}

/** Greedy non-overlapping cuboids used for the NCM2 compatibility export. */
export function optimizeVoxelCuboids(voxels) {
  const occupied = new Map([...voxels].map(([key, voxel]) => [key, voxel.material]));
  const visited = new Set();
  const sorted = [...voxels.values()].sort((a, b) => a.material - b.material || a.y - b.y || a.z - b.z || a.x - b.x);
  const cuboids = [];
  for (const voxel of sorted) {
    const start = `${voxel.x},${voxel.y},${voxel.z}`;
    if (visited.has(start)) continue;
    let w = 1;
    while (rectAvailable(occupied, visited, voxel.material, voxel.x, voxel.y, voxel.z, w + 1, 1, 1)) w++;
    let d = 1;
    while (rectAvailable(occupied, visited, voxel.material, voxel.x, voxel.y, voxel.z, w, 1, d + 1)) d++;
    let h = 1;
    while (rectAvailable(occupied, visited, voxel.material, voxel.x, voxel.y, voxel.z, w, h + 1, d)) h++;
    markRect(visited, voxel.x, voxel.y, voxel.z, w, h, d);
    cuboids.push({ x: voxel.x, y: voxel.y, z: voxel.z, w, h, d, material: voxel.material });
  }
  return cuboids;
}

/** Current-client fallback: canonical material IDs become the existing NCM2 RGB palette. */
export function encodeNcm2Compatibility(sizeInput, cuboids) {
  const size = normalizeSize(sizeInput);
  const source = cuboids.map((cuboid) => ({
    color: MATERIALS[cuboid.material]?.color ?? "#ffffff",
    x: cuboid.x,
    y: cuboid.z,
    z: cuboid.y,
    w: cuboid.w,
    h: cuboid.h,
    d: cuboid.d,
  }));
  const ncmSize = { x: size.x, y: size.z, z: size.y };
  const palette = [];
  const paletteIndex = new Map();
  for (const part of source) {
    if (!paletteIndex.has(part.color)) {
      paletteIndex.set(part.color, palette.length);
      palette.push(part.color);
    }
  }
  const bytes = [];
  [ncmSize.x, ncmSize.y, ncmSize.z, 100, source.length, palette.length].forEach((value) => writeVar(bytes, value));
  for (const color of palette) writeRgb(bytes, color);
  const bitWriter = createBitWriter();
  const colorBits = bitWidth(palette.length - 1);
  const xBits = bitWidth(ncmSize.x - 1);
  const yBits = bitWidth(ncmSize.y - 1);
  const zBits = bitWidth(ncmSize.z - 1);
  for (const part of source) {
    bitWriter.write(paletteIndex.get(part.color), colorBits);
    bitWriter.write(part.x, xBits); bitWriter.write(part.y, yBits); bitWriter.write(part.z, zBits);
    bitWriter.write(part.w - 1, xBits); bitWriter.write(part.h - 1, zBits); bitWriter.write(part.d - 1, yBits);
  }
  bytes.push(...bitWriter.finish());
  return `${NCM2_PREFIX}${base64UrlEncode(Uint8Array.from(bytes))}`;
}

export function describeBlueprint(blueprint) {
  return blueprint.commands.map((command, index) => ({ ...command, index, op: OPCODE_NAME[command.op], opCode: command.op }));
}

export function payloadByteLength(code) {
  const text = String(code ?? "");
  const colon = text.indexOf(":");
  return colon >= 0 ? decodeCanonicalPayload(text.slice(colon + 1), "NCM").length : 0;
}

/**
 * Blueprint PDA account layout (little-endian):
 * 0..3   "NCBP"
 * 4      version (1)
 * 5      flags (bit 0: raw NCM3 binary payload; otherwise UTF-8 code)
 * 6..7   reserved
 * 8..39  authority pubkey
 * 40..71 sha256(stored payload)
 * 72..75 stored payload length u32
 * 76..   raw NCM3 bytes or UTF-8 NCM code
 *
 * For early experiments, a raw account containing NCM3:/NCM2: text is also
 * accepted. Production clients should use NCBP and verify its hash.
 */
export async function decodeBlueprintAccount(rawInput) {
  let byteLength;
  if (rawInput instanceof ArrayBuffer) byteLength = rawInput.byteLength;
  else if (ArrayBuffer.isView(rawInput)) byteLength = rawInput.byteLength;
  else throw new TypeError("Blueprint account input must be an ArrayBuffer or ArrayBufferView.");
  if (byteLength > MAX_BLUEPRINT_ACCOUNT_BYTES) throw new Error("Blueprint account exceeds the safety limit.");
  const raw = rawInput instanceof ArrayBuffer
    ? new Uint8Array(rawInput)
    : new Uint8Array(rawInput.buffer, rawInput.byteOffset, rawInput.byteLength);
  const text = new TextDecoder().decode(raw).replace(/\0+$/g, "").trim();
  if (text.startsWith(NCM3_PREFIX) || text.startsWith(NCM2_PREFIX)) return { code: text, version: 0, verified: false, raw: true };
  if (raw.length < NCBP_HEADER_BYTES || new TextDecoder().decode(raw.slice(0, 4)) !== "NCBP") throw new Error("Account is not an NCBP blueprint account.");
  const version = raw[4];
  if (version !== 1) throw new Error(`Unsupported NCBP account version ${version}.`);
  const length = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(72, true);
  if (length > NCM3_MAX_PAYLOAD_BYTES || NCBP_HEADER_BYTES + length > raw.length) throw new Error("Invalid NCBP code length.");
  const stored = raw.slice(NCBP_HEADER_BYTES, NCBP_HEADER_BYTES + length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stored));
  const expected = raw.slice(40, 72);
  const verified = digest.every((value, index) => value === expected[index]);
  if (!verified) throw new Error("NCBP code hash mismatch.");
  const flags = raw[5];
  const code = flags & 1 ? `${NCM3_PREFIX}${base64UrlEncode(stored)}` : new TextDecoder().decode(stored);
  return { code, version, flags, verified, raw: false, storedBytes: stored.length };
}

export async function fetchBlueprintFromPda({ rpcUrl, address }) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}.`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || "RPC request failed.");
  const encoded = json.result?.value?.data?.[0];
  if (!encoded) throw new Error("PDA account was not found.");
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_BLUEPRINT_ACCOUNT_BYTES * 4 / 3) + 2) {
    throw new Error("Blueprint account exceeds the safety limit.");
  }
  let raw;
  try {
    raw = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    throw new Error("RPC returned invalid Base64 account data.");
  }
  return decodeBlueprintAccount(raw);
}

function validateBlueprint(blueprint) {
  const size = normalizeSize(blueprint?.size);
  if (!Array.isArray(blueprint?.commands)) throw new Error("Blueprint commands are required.");
  if (blueprint.commands.length > NCM3_MAX_COMMANDS) throw new Error("Blueprint command limit exceeded.");
  let operationUpperBound = 0;
  let contentBounds = null;
  const referencedMaterials = new Set();
  for (const command of blueprint.commands) {
    if (!Object.values(OPCODE).includes(command.op)) throw new Error("Unknown blueprint command.");
    const ids = command.op === OPCODE.TREE ? [command.trunkMaterial, command.leafMaterial] : [command.material];
    ids.forEach((id) => {
      if (!MATERIALS[id]) throw new Error(`Unknown canonical material ID ${id}.`);
      referencedMaterials.add(id);
    });
    const integer = (value, label, min, max) => {
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is outside the NCM3 safety bounds.`);
    };
    if (command.op === OPCODE.BOX || command.op === OPCODE.REPEAT_BOX) {
      integer(command.x, "x", 0, size.x - 1); integer(command.y, "y", 0, size.y - 1); integer(command.z, "z", 0, size.z - 1);
      integer(command.w, "width", 1, size.x); integer(command.h, "height", 1, size.y); integer(command.d, "depth", 1, size.z);
      if (command.op === OPCODE.BOX) {
        validateCuboid(command, size);
      }
    }
    if (command.op === OPCODE.REPEAT_BOX) {
      integer(command.count, "repeat count", 1, 512);
      integer(command.dx, "repeat dx", -256, 256); integer(command.dy, "repeat dy", -256, 256); integer(command.dz, "repeat dz", -256, 256);
      validateRepeatedAxis(command.x, command.w, command.dx, command.count, size.x, "x");
      validateRepeatedAxis(command.y, command.h, command.dy, command.count, size.y, "y");
      validateRepeatedAxis(command.z, command.d, command.dz, command.count, size.z, "z");
    }
    if (GABLE_OPS.has(command.op)) {
      integer(command.x, "x", 0, size.x - 1); integer(command.y, "y", 0, size.y - 1); integer(command.z, "z", 0, size.z - 1);
      integer(command.width, "gable width", 1, size.x); integer(command.depth, "gable depth", 1, size.z);
      const layers = Math.ceil((command.op === OPCODE.GABLE_Z || command.op === OPCODE.GABLE_TRIM_Z || command.op === OPCODE.GABLE_FILL_Z
        ? command.depth
        : command.width) / 2);
      validateCuboid({
        x: command.x,
        y: command.y,
        z: command.z,
        w: command.width,
        h: layers,
        d: command.depth,
      }, size);
    }
    if (command.op === OPCODE.TREE) {
      integer(command.x, "x", 0, size.x - 1); integer(command.y, "y", 0, size.y - 1); integer(command.z, "z", 0, size.z - 1);
      integer(command.height, "tree height", 2, Math.min(64, size.y)); integer(command.crownRadius, "crown radius", 1, 16);
      const trunkHeight = Math.max(2, command.height - command.crownRadius);
      const crownDiameter = command.crownRadius * 2 + 2;
      validateCuboid({
        x: command.x - command.crownRadius,
        y: command.y,
        z: command.z - command.crownRadius,
        w: crownDiameter,
        h: Math.max(command.height, command.crownRadius + 1),
        d: crownDiameter,
      }, size);
    }
    if (command.op === OPCODE.FENCE) {
      integer(command.x, "x", 0, size.x - 1); integer(command.y, "y", 0, size.y - 1); integer(command.z, "z", 0, size.z - 1);
      integer(command.length, "fence length", 1, NCM3_MAX_DIMENSION); integer(command.axis, "fence axis", 0, 1); integer(command.spacing, "fence spacing", 1, 64);
      const axisX = command.axis === 0;
      validateCuboid({
        x: command.x,
        y: command.y,
        z: command.z,
        w: axisX ? command.length : 1,
        h: 5,
        d: axisX ? 1 : command.length,
      }, size);
    }
    const envelope = commandEnvelope(command);
    operationUpperBound += envelope.operationUpperBound;
    contentBounds = unionBounds(contentBounds, envelope.bounds);
    if (operationUpperBound > NCM3_MAX_EXPANDED_OPERATIONS) {
      throw new Error("Expanded voxel operation budget exceeded.");
    }
  }
  return {
    size,
    operationUpperBound,
    referencedMaterials: [...referencedMaterials].sort((left, right) => left - right),
    contentBounds: contentBounds ?? emptyContentBounds(),
  };
}

function commandEnvelope(command) {
  if (command.op === OPCODE.BOX) {
    return cuboidEnvelope(command, command.w * command.h * command.d);
  }
  if (command.op === OPCODE.REPEAT_BOX) {
    const lastX = command.x + command.dx * (command.count - 1);
    const lastY = command.y + command.dy * (command.count - 1);
    const lastZ = command.z + command.dz * (command.count - 1);
    return {
      operationUpperBound: command.w * command.h * command.d * command.count,
      bounds: boundsFromExtents(
        Math.min(command.x, lastX),
        Math.min(command.y, lastY),
        Math.min(command.z, lastZ),
        Math.max(command.x, lastX) + command.w - 1,
        Math.max(command.y, lastY) + command.h - 1,
        Math.max(command.z, lastZ) + command.d - 1,
      ),
    };
  }
  if (GABLE_OPS.has(command.op)) {
    const zOriented = command.op === OPCODE.GABLE_Z
      || command.op === OPCODE.GABLE_TRIM_Z
      || command.op === OPCODE.GABLE_FILL_Z;
    const layers = Math.ceil((zOriented ? command.depth : command.width) / 2);
    let operationUpperBound;
    if (command.op === OPCODE.GABLE) operationUpperBound = layers * 2 * command.depth;
    else if (command.op === OPCODE.GABLE_TRIM) operationUpperBound = layers * 4;
    else if (command.op === OPCODE.GABLE_FILL) operationUpperBound = layers * command.width * command.depth;
    else if (command.op === OPCODE.GABLE_Z) operationUpperBound = layers * 2 * command.width;
    else if (command.op === OPCODE.GABLE_TRIM_Z) operationUpperBound = layers * 4;
    else operationUpperBound = layers * command.width * command.depth;
    return cuboidEnvelope({
      x: command.x,
      y: command.y,
      z: command.z,
      w: command.width,
      h: layers,
      d: command.depth,
    }, operationUpperBound);
  }
  if (command.op === OPCODE.TREE) {
    const trunkHeight = Math.max(2, command.height - command.crownRadius);
    const crownDiameter = command.crownRadius * 2 + 2;
    return cuboidEnvelope({
      x: command.x - command.crownRadius,
      y: command.y,
      z: command.z - command.crownRadius,
      w: crownDiameter,
      h: Math.max(command.height, command.crownRadius + 1),
      d: crownDiameter,
    }, trunkHeight * 4 + command.crownRadius * 8 * crownDiameter + 4);
  }
  if (command.op === OPCODE.FENCE) {
    const axisX = command.axis === 0;
    return cuboidEnvelope({
      x: command.x,
      y: command.y,
      z: command.z,
      w: axisX ? command.length : 1,
      h: 5,
      d: axisX ? 1 : command.length,
    }, command.length * 2 + (Math.ceil(command.length / command.spacing) + 1) * 5);
  }
  throw new Error("Unknown blueprint command.");
}

function cuboidEnvelope(cuboid, operationUpperBound) {
  return {
    operationUpperBound,
    bounds: boundsFromExtents(
      cuboid.x,
      cuboid.y,
      cuboid.z,
      cuboid.x + cuboid.w - 1,
      cuboid.y + cuboid.h - 1,
      cuboid.z + cuboid.d - 1,
    ),
  };
}

function unionBounds(current, next) {
  if (!current) return next;
  return boundsFromExtents(
    Math.min(current.minX, next.minX),
    Math.min(current.minY, next.minY),
    Math.min(current.minZ, next.minZ),
    Math.max(current.maxX, next.maxX),
    Math.max(current.maxY, next.maxY),
    Math.max(current.maxZ, next.maxZ),
  );
}

function boundsFromExtents(minX, minY, minZ, maxX, maxY, maxZ) {
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    depth: maxZ - minZ + 1,
  };
}

function emptyContentBounds() {
  return { minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1, width: 0, height: 0, depth: 0 };
}

function validateCuboid(cuboid, size) {
  for (const [key, minimum] of [["x", 0], ["y", 0], ["z", 0], ["w", 1], ["h", 1], ["d", 1]]) {
    if (!Number.isInteger(cuboid?.[key]) || cuboid[key] < minimum) {
      throw new Error("A building command extends outside the declared blueprint dimensions.");
    }
  }
  if (cuboid.x + cuboid.w > size.x
    || cuboid.y + cuboid.h > size.y
    || cuboid.z + cuboid.d > size.z) {
    throw new Error("A building command extends outside the declared blueprint dimensions.");
  }
}

function validateRepeatedAxis(start, length, step, count, limit, label) {
  const last = start + step * (count - 1);
  const minimum = Math.min(start, last);
  const maximumExclusive = Math.max(start, last) + length;
  if (!Number.isSafeInteger(last) || minimum < 0 || maximumExclusive > limit) {
    throw new Error(`Repeated ${label} geometry extends outside the declared blueprint dimensions.`);
  }
}

function normalizeSize(size) {
  const normalized = { x: Number(size?.x), y: Number(size?.y), z: Number(size?.z) };
  for (const value of Object.values(normalized)) {
    if (!Number.isInteger(value) || value < 1 || value > NCM3_MAX_DIMENSION) {
      throw new Error(`Blueprint dimensions must be integers from 1 to ${NCM3_MAX_DIMENSION}.`);
    }
  }
  return normalized;
}

function writeMaterial(bytes, value) {
  const material = Number(value);
  if (!MATERIALS[material]) throw new Error(`Unknown canonical material ID ${value}.`);
  writeVar(bytes, material);
}

function readMaterial(reader) {
  const value = readVar(reader);
  if (!MATERIALS[value]) throw new Error(`Unknown canonical material ID ${value}.`);
  return value;
}

function rectAvailable(occupied, visited, material, x, y, z, w, h, d) {
  for (let yy = 0; yy < h; yy++) for (let zz = 0; zz < d; zz++) for (let xx = 0; xx < w; xx++) {
    const key = `${x + xx},${y + yy},${z + zz}`;
    if (visited.has(key) || occupied.get(key) !== material) return false;
  }
  return true;
}

function markRect(visited, x, y, z, w, h, d) {
  for (let yy = 0; yy < h; yy++) for (let zz = 0; zz < d; zz++) for (let xx = 0; xx < w; xx++) visited.add(`${x + xx},${y + yy},${z + zz}`);
}

function writeRgb(bytes, color) {
  bytes.push(parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16));
}

function rgbBytesToHex(values) {
  return `#${values.slice(0, 3).map((value) => Math.max(0, Math.min(255, value | 0)).toString(16).padStart(2, "0")).join("")}`;
}

function writeVar(bytes, value) {
  if (!Number.isInteger(value) || value < 0 || value > NCM3_MAX_U32) {
    throw new Error("NCM3 varint values must be unsigned 32-bit integers.");
  }
  let next = value;
  while (next > 127) { bytes.push((next % 128) + 128); next = Math.floor(next / 128); }
  bytes.push(next);
}

function readVar(reader) {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 5; index += 1) {
    const byte = reader.read();
    const payload = byte & 127;
    value += payload * multiplier;
    if (value > NCM3_MAX_U32) throw new Error("NCM3 varint is too large.");
    if ((byte & 128) === 0) {
      if (index > 0 && payload === 0) throw new Error("NCM3 varint is not canonical.");
      return value;
    }
    multiplier *= 128;
  }
  throw new Error("NCM3 varint is too large.");
}

function writeSignedVar(bytes, value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error("NCM3 signed varint values must be signed 32-bit integers.");
  }
  writeVar(bytes, value < 0 ? Math.abs(value) * 2 - 1 : value * 2);
}

function readSignedVar(reader) {
  const value = readVar(reader);
  return value & 1 ? -((value + 1) / 2) : value / 2;
}

function bitWidth(maxValue) {
  return Math.max(1, Math.floor(Math.log2(Math.max(0, maxValue))) + 1);
}

function createBitWriter() {
  const bytes = [];
  let current = 0;
  let used = 0;
  return {
    write(value, bits) {
      for (let bit = 0; bit < bits; bit++) {
        current |= ((value >> bit) & 1) << used++;
        if (used === 8) { bytes.push(current); current = 0; used = 0; }
      }
    },
    finish() { if (used) bytes.push(current); return bytes; },
  };
}

function createByteReader(raw) {
  let offset = 0;
  return {
    read() { if (offset >= raw.length) throw new Error("Unexpected end of data."); return raw[offset++]; },
    done() { return offset === raw.length; },
  };
}

function base64UrlEncode(raw) {
  let binary = "";
  raw.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeCanonicalPayload(encoded, format) {
  if (encoded.length > NCM_MAX_ENCODED_LENGTH) {
    throw new Error(`${format} payload exceeds the safety limit.`);
  }
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error(`Invalid canonical ${format} Base64URL payload.`);
  }
  let raw;
  try {
    raw = base64UrlDecode(encoded);
  } catch {
    throw new Error(`Invalid canonical ${format} Base64URL payload.`);
  }
  if (raw.length > NCM3_MAX_PAYLOAD_BYTES) throw new Error(`${format} payload exceeds the safety limit.`);
  if (base64UrlEncode(raw) !== encoded) throw new Error(`Invalid canonical ${format} Base64URL payload.`);
  return raw;
}
