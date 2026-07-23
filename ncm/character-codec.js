/**
 * Chunk.js NCM4 self-contained animated voxel character codec.
 *
 * Coordinate convention:
 * - `unit` is the number of voxel-grid units in one rendered world unit.
 * - cuboid `origin` is its minimum [x, y, z] corner and `size` is [w, h, d].
 * - y points up; z is the model depth axis.
 * - bone pivots use the same grid and may use half-grid coordinates.
 * - action rotations are sparse Euler [x, y, z] values in radians.
 *
 * The binary payload is deliberately bounded to the largest raw payload that
 * still fits in a 2,048-byte UTF-8 field after the `NCM4:` Base64URL envelope.
 */

export const NCM4_PREFIX = "NCM4:";
export const NCM4_VERSION = 1;
export const NCM4_TICKS_PER_SECOND = 30;
export const NCM4_ROTATION_STEP_RADIANS = Math.PI / 128;
export const NCM4_MAX_PAYLOAD_BYTES = 1532;

const NCM4_FLAGS = 0;
const MAX_UNIT = 4096;
const MAX_PALETTE = 64;
const MAX_CUBOIDS = 512;
const MAX_GROUP = 15;
const MAX_COORDINATE = 32767;
const MIN_COORDINATE = -32768;
const MAX_SIZE = 256;
const MAX_DURATION_TICKS = 65535;
const MAX_KEYFRAMES = 256;
const MAX_VISIBLE_GROUP_MASK = 0xffff;

const BONE_DEFINITIONS = [
  ["root", -1],
  ["hips", 0],
  ["torso", 1],
  ["chest", 2],
  ["neck", 3],
  ["head", 4],
  ["left_upper_arm", 3],
  ["left_lower_arm", 6],
  ["left_hand", 7],
  ["right_upper_arm", 3],
  ["right_lower_arm", 9],
  ["right_hand", 10],
  ["left_upper_leg", 1],
  ["left_lower_leg", 12],
  ["left_foot", 13],
  ["right_upper_leg", 1],
  ["right_lower_leg", 15],
  ["right_foot", 16],
  ["backpack", 3],
  ["accessory", 0],
];

export const NCM4_BONES = Object.freeze(BONE_DEFINITIONS.map(([name, parent], id) => Object.freeze({
  id,
  name,
  parent,
})));

export const NCM4_BONE_IDS = Object.freeze(Object.fromEntries(
  NCM4_BONES.map(({ id, name }) => [name, id]),
));

const ACTION_DEFINITIONS = [
  ["idle", 0],
  ["greet_customer", 1],
  ["show_goods", 2],
  ["record_price", 3],
  ["complete_trade", 4],
];

export const NCM4_ACTIONS = Object.freeze(ACTION_DEFINITIONS.map(([name, id]) => Object.freeze({ id, name })));

export const NCM4_ACTION_IDS = Object.freeze(Object.fromEntries(
  NCM4_ACTIONS.map(({ id, name }) => [name, id]),
));

const ACTION_BY_ID = new Map(NCM4_ACTIONS.map((action) => [action.id, action]));
const CRC32C_TABLE = createCrc32cTable();

/** Encode a self-contained NCM4 character as canonical unpadded Base64URL. */
export function encodeNcm4(model) {
  const normalized = normalizeModel(model);
  const bytes = [NCM4_VERSION, NCM4_FLAGS];

  writeUVar(bytes, normalized.unit);
  writeUVar(bytes, normalized.palette.length);
  writeUVar(bytes, normalized.cuboids.length);
  writeUVar(bytes, normalized.actions.length);

  for (const color of normalized.palette) {
    bytes.push(
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
    );
  }

  const halfPivots = normalized.pivots.map((pivot) => pivot.map((value) => Math.round(value * 2)));
  for (const bone of NCM4_BONES) {
    const parentPivot = bone.parent < 0 ? [0, 0, 0] : halfPivots[bone.parent];
    for (let axis = 0; axis < 3; axis++) writeSVar(bytes, halfPivots[bone.id][axis] - parentPivot[axis]);
  }

  const bitWidths = geometryBitWidths(normalized);
  bytes.push(
    bitWidths.bone,
    bitWidths.group,
    bitWidths.x,
    bitWidths.y,
    bitWidths.z,
    bitWidths.w,
    bitWidths.h,
    bitWidths.d,
  );

  const paletteBits = bitWidth(normalized.palette.length - 1);
  const geometryWriter = createBitWriter();
  for (const cuboid of normalized.cuboids) {
    geometryWriter.write(cuboid.paletteIndex, paletteBits);
    geometryWriter.write(cuboid.bone, bitWidths.bone);
    geometryWriter.write(cuboid.group, bitWidths.group);
    geometryWriter.write(zigZagEncode(cuboid.origin[0]), bitWidths.x);
    geometryWriter.write(zigZagEncode(cuboid.origin[1]), bitWidths.y);
    geometryWriter.write(zigZagEncode(cuboid.origin[2]), bitWidths.z);
    geometryWriter.write(cuboid.size[0] - 1, bitWidths.w);
    geometryWriter.write(cuboid.size[1] - 1, bitWidths.h);
    geometryWriter.write(cuboid.size[2] - 1, bitWidths.d);
  }
  bytes.push(...geometryWriter.finish());

  for (const action of normalized.actions) {
    bytes.push(action.id | (action.loop ? 0x80 : 0));
    writeUVar(bytes, action.durationTicks);
    writeUVar(bytes, action.visibleGroupMask);
    writeUVar(bytes, action.keyframes.length);
    let previousTick = 0;
    for (const [frameIndex, keyframe] of action.keyframes.entries()) {
      writeUVar(bytes, frameIndex === 0 ? keyframe.tick : keyframe.tick - previousTick);
      writeUVar(bytes, keyframe.rotations.length);
      for (const rotation of keyframe.rotations) {
        bytes.push(rotation.bone, ...rotation.quantized.map(signedByte));
      }
      previousTick = keyframe.tick;
    }
  }

  const body = Uint8Array.from(bytes);
  if (body.length + 4 > NCM4_MAX_PAYLOAD_BYTES) {
    throw new Error(`NCM4 payload is ${body.length + 4} bytes; the on-chain limit is ${NCM4_MAX_PAYLOAD_BYTES} bytes.`);
  }
  const checksum = ncm4Crc32c(body);
  const raw = new Uint8Array(body.length + 4);
  raw.set(body);
  new DataView(raw.buffer).setUint32(body.length, checksum, true);
  return `${NCM4_PREFIX}${base64UrlEncode(raw)}`;
}

/** Decode and fully validate a canonical NCM4 character. */
export function decodeNcm4(code) {
  const { raw, body, text } = readEnvelope(code);
  const reader = createByteReader(body);
  const version = reader.readByte("version");
  if (version !== NCM4_VERSION) throw new Error(`Unsupported NCM4 version ${version}.`);
  const flags = reader.readByte("flags");
  if (flags !== NCM4_FLAGS) throw new Error("NCM4 reserved flags must be zero.");

  const unit = readBoundedVar(reader, "unit", 1, MAX_UNIT);
  const paletteCount = readBoundedVar(reader, "palette count", 1, MAX_PALETTE);
  const cuboidCount = readBoundedVar(reader, "cuboid count", 1, MAX_CUBOIDS);
  const actionCount = readBoundedVar(reader, "action count", 0, NCM4_ACTIONS.length);

  const palette = [];
  const paletteSet = new Set();
  for (let index = 0; index < paletteCount; index++) {
    const color = rgbToHex(
      reader.readByte("palette red"),
      reader.readByte("palette green"),
      reader.readByte("palette blue"),
    );
    if (paletteSet.has(color)) throw new Error("NCM4 palette colors must be unique.");
    paletteSet.add(color);
    palette.push(color);
  }

  const halfPivots = [];
  const pivots = [];
  for (const bone of NCM4_BONES) {
    const parentPivot = bone.parent < 0 ? [0, 0, 0] : halfPivots[bone.parent];
    const pivot = [0, 1, 2].map((axis) => parentPivot[axis] + reader.readSVar(`bone ${bone.name} pivot`));
    for (const value of pivot) {
      if (value < MIN_COORDINATE * 2 || value > MAX_COORDINATE * 2) {
        throw new Error(`NCM4 bone ${bone.name} pivot is outside the coordinate bounds.`);
      }
    }
    halfPivots.push(pivot);
    pivots.push(pivot.map((value) => value / 2));
  }

  const bitWidths = {
    bone: reader.readByte("bone bit width"),
    group: reader.readByte("group bit width"),
    x: reader.readByte("x bit width"),
    y: reader.readByte("y bit width"),
    z: reader.readByte("z bit width"),
    w: reader.readByte("width bit width"),
    h: reader.readByte("height bit width"),
    d: reader.readByte("depth bit width"),
  };
  validateStoredBitWidths(bitWidths);

  const paletteBits = bitWidth(paletteCount - 1);
  const bitsPerCuboid = paletteBits + Object.values(bitWidths).reduce((sum, value) => sum + value, 0);
  const geometryByteLength = Math.ceil((bitsPerCuboid * cuboidCount) / 8);
  const geometryReader = createBitReader(reader.readBytes(geometryByteLength, "cuboid geometry"));
  const cuboids = [];
  let usedGroupMask = 0;
  for (let index = 0; index < cuboidCount; index++) {
    const paletteIndex = geometryReader.read(paletteBits);
    const bone = geometryReader.read(bitWidths.bone);
    const group = geometryReader.read(bitWidths.group);
    const origin = [
      zigZagDecode(geometryReader.read(bitWidths.x)),
      zigZagDecode(geometryReader.read(bitWidths.y)),
      zigZagDecode(geometryReader.read(bitWidths.z)),
    ];
    const size = [
      geometryReader.read(bitWidths.w) + 1,
      geometryReader.read(bitWidths.h) + 1,
      geometryReader.read(bitWidths.d) + 1,
    ];
    if (paletteIndex >= palette.length) throw new Error("NCM4 cuboid palette index is out of range.");
    if (bone >= NCM4_BONES.length) throw new Error("NCM4 cuboid bone index is out of range.");
    if (group > MAX_GROUP) throw new Error("NCM4 cuboid group is out of range.");
    origin.forEach((value) => validateIntegerRange(value, "NCM4 cuboid coordinate", MIN_COORDINATE, MAX_COORDINATE));
    size.forEach((value) => validateIntegerRange(value, "NCM4 cuboid size", 1, MAX_SIZE));
    usedGroupMask |= 1 << group;
    cuboids.push({
      paletteIndex,
      color: palette[paletteIndex],
      bone,
      boneName: NCM4_BONES[bone].name,
      group,
      origin,
      size,
    });
  }
  geometryReader.assertCanonicalPadding();
  if ((usedGroupMask & 1) === 0) throw new Error("NCM4 characters must contain body geometry in group 0.");

  const actions = [];
  let previousActionId = -1;
  for (let actionIndex = 0; actionIndex < actionCount; actionIndex++) {
    const actionHeader = reader.readByte("action header");
    if (actionHeader & 0x60) throw new Error("NCM4 action header contains reserved bits.");
    const id = actionHeader & 0x1f;
    const definition = ACTION_BY_ID.get(id);
    if (!definition) throw new Error(`Unknown NCM4 action ID ${id}.`);
    if (id <= previousActionId) throw new Error("NCM4 actions must have unique ascending IDs.");
    previousActionId = id;
    const durationTicks = readBoundedVar(reader, "action duration", 1, MAX_DURATION_TICKS);
    const visibleGroupMask = readBoundedVar(reader, "visible group mask", 1, MAX_VISIBLE_GROUP_MASK);
    validateVisibleGroupMask(visibleGroupMask, usedGroupMask);
    const keyframeCount = readBoundedVar(reader, "keyframe count", 1, MAX_KEYFRAMES);
    const keyframes = [];
    let previousTick = 0;
    for (let frameIndex = 0; frameIndex < keyframeCount; frameIndex++) {
      const tickDelta = reader.readUVar("keyframe tick delta");
      if (frameIndex === 0 && tickDelta !== 0) throw new Error("The first NCM4 keyframe must be at tick 0.");
      if (frameIndex > 0 && tickDelta === 0) throw new Error("NCM4 keyframe ticks must be strictly increasing.");
      const tick = frameIndex === 0 ? tickDelta : previousTick + tickDelta;
      if (tick > durationTicks) throw new Error("NCM4 keyframe exceeds its action duration.");
      const rotationCount = readBoundedVar(reader, "keyframe rotation count", 1, NCM4_BONES.length);
      const rotations = [];
      let previousBone = -1;
      for (let rotationIndex = 0; rotationIndex < rotationCount; rotationIndex++) {
        const bone = reader.readByte("rotation bone");
        if (bone >= NCM4_BONES.length) throw new Error("NCM4 rotation bone index is out of range.");
        if (bone <= previousBone) throw new Error("NCM4 keyframe bones must have unique ascending IDs.");
        previousBone = bone;
        const quantized = [
          unsignedToSignedByte(reader.readByte("x rotation")),
          unsignedToSignedByte(reader.readByte("y rotation")),
          unsignedToSignedByte(reader.readByte("z rotation")),
        ];
        rotations.push({
          bone,
          boneName: NCM4_BONES[bone].name,
          rotation: quantized.map((value) => value * NCM4_ROTATION_STEP_RADIANS),
        });
      }
      keyframes.push({ tick, rotations });
      previousTick = tick;
    }
    actions.push({
      id,
      name: definition.name,
      durationTicks,
      duration: durationTicks,
      ticksPerSecond: NCM4_TICKS_PER_SECOND,
      loop: Boolean(actionHeader & 0x80),
      visibleGroupMask,
      visibleGroups: groupsFromMask(visibleGroupMask),
      keyframes,
    });
  }

  if (!reader.done()) throw new Error("Unexpected trailing NCM4 bytes.");
  const decodedForWidths = { cuboids, actions };
  const canonicalWidths = geometryBitWidths(decodedForWidths);
  for (const key of Object.keys(bitWidths)) {
    if (bitWidths[key] !== canonicalWidths[key]) throw new Error(`NCM4 ${key} bit width is not canonical.`);
  }

  const bones = NCM4_BONES.map((bone) => ({ ...bone, pivot: [...pivots[bone.id]] }));
  const character = {
    format: "NCM4",
    v: 4,
    version,
    unit,
    palette,
    bones,
    pivots,
    cuboids,
    actions,
    clips: actions,
    ticksPerSecond: NCM4_TICKS_PER_SECOND,
    rotationUnit: "radians",
    payloadBytes: raw.length,
  };

  if (encodeNcm4(character) !== text) throw new Error("NCM4 payload is not canonically encoded.");
  return character;
}

/** Return the raw binary payload length, including the four-byte CRC32C. */
export function ncm4PayloadByteLength(code) {
  return readEnvelope(code).raw.length;
}

/** Castagnoli CRC-32 used by the NCM4 envelope. */
export function ncm4Crc32c(input) {
  let byteLength;
  if (input instanceof ArrayBuffer) byteLength = input.byteLength;
  else if (ArrayBuffer.isView(input)) byteLength = input.byteLength;
  else throw new TypeError("NCM4 CRC32C input must be an ArrayBuffer or ArrayBufferView.");
  if (byteLength > NCM4_MAX_PAYLOAD_BYTES) {
    throw new RangeError(`NCM4 CRC32C input exceeds ${NCM4_MAX_PAYLOAD_BYTES} bytes.`);
  }
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeModel(model) {
  if (!model || typeof model !== "object") throw new Error("An NCM4 character model is required.");
  const unit = normalizeInteger(model.unit, "NCM4 unit", 1, MAX_UNIT);
  const palette = normalizePalette(model.palette);
  const pivots = normalizePivots(model);
  const cuboids = normalizeCuboids(model.cuboids, palette);
  const usedGroupMask = cuboids.reduce((mask, cuboid) => mask | (1 << cuboid.group), 0);
  if ((usedGroupMask & 1) === 0) throw new Error("NCM4 characters must contain body geometry in group 0.");
  const actions = normalizeActions(model.actions ?? model.clips ?? [], usedGroupMask);
  return { unit, palette, pivots, cuboids, actions };
}

function normalizePalette(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PALETTE) {
    throw new Error(`NCM4 palette must contain 1 to ${MAX_PALETTE} RGB colors.`);
  }
  const palette = input.map(normalizeColor);
  if (new Set(palette).size !== palette.length) throw new Error("NCM4 palette colors must be unique.");
  return palette;
}

function normalizePivots(model) {
  const input = model.pivots ?? model.bones;
  const ordered = new Array(NCM4_BONES.length);
  if (Array.isArray(input)) {
    if (input.length !== NCM4_BONES.length) throw new Error(`NCM4 requires exactly ${NCM4_BONES.length} bone pivots.`);
    input.forEach((entry, index) => {
      const isVector = Array.isArray(entry);
      const id = isVector ? index : resolveBone(entry?.id ?? entry?.name ?? index);
      if (ordered[id]) throw new Error(`Duplicate NCM4 bone pivot for ${NCM4_BONES[id].name}.`);
      if (!isVector && entry?.parent != null && entry.parent !== NCM4_BONES[id].parent) {
        throw new Error(`NCM4 bone ${NCM4_BONES[id].name} has a fixed parent.`);
      }
      ordered[id] = normalizePivot(isVector ? entry : entry?.pivot, NCM4_BONES[id].name);
    });
  } else if (input && typeof input === "object") {
    for (const bone of NCM4_BONES) {
      const entry = input[bone.name] ?? input[bone.id];
      ordered[bone.id] = normalizePivot(entry?.pivot ?? entry, bone.name);
    }
  } else {
    throw new Error("NCM4 bone pivots are required.");
  }
  if (ordered.some((pivot) => !pivot)) throw new Error(`NCM4 requires exactly ${NCM4_BONES.length} bone pivots.`);
  return ordered;
}

function normalizePivot(input, name) {
  const pivot = normalizeVector(input, `NCM4 ${name} pivot`, 3);
  return pivot.map((value) => {
    if (value < MIN_COORDINATE || value > MAX_COORDINATE || !Number.isInteger(value * 2)) {
      throw new Error(`NCM4 ${name} pivot must use half-grid coordinates within the supported bounds.`);
    }
    return value;
  });
}

function normalizeCuboids(input, palette) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CUBOIDS) {
    throw new Error(`NCM4 cuboids must contain 1 to ${MAX_CUBOIDS} entries.`);
  }
  return input.map((cuboid, index) => {
    if (!cuboid || typeof cuboid !== "object") throw new Error(`NCM4 cuboid ${index} is invalid.`);
    let paletteIndex = cuboid.paletteIndex;
    if (cuboid.color != null) {
      const colorIndex = palette.indexOf(normalizeColor(cuboid.color));
      if (colorIndex < 0) throw new Error(`NCM4 cuboid ${index} color is not in the palette.`);
      if (paletteIndex != null && paletteIndex !== colorIndex) throw new Error(`NCM4 cuboid ${index} has conflicting color fields.`);
      paletteIndex = colorIndex;
    }
    paletteIndex = normalizeInteger(paletteIndex, `NCM4 cuboid ${index} palette index`, 0, palette.length - 1);
    const bone = resolveBone(cuboid.bone ?? 0);
    const group = normalizeInteger(cuboid.group ?? 0, `NCM4 cuboid ${index} group`, 0, MAX_GROUP);
    const originInput = cuboid.origin ?? [cuboid.x, cuboid.y, cuboid.z];
    const sizeInput = cuboid.size ?? [cuboid.w, cuboid.h, cuboid.d];
    const origin = normalizeVector(originInput, `NCM4 cuboid ${index} origin`, 3)
      .map((value) => normalizeInteger(value, `NCM4 cuboid ${index} coordinate`, MIN_COORDINATE, MAX_COORDINATE));
    const size = normalizeVector(sizeInput, `NCM4 cuboid ${index} size`, 3)
      .map((value) => normalizeInteger(value, `NCM4 cuboid ${index} size`, 1, MAX_SIZE));
    return { paletteIndex, bone, group, origin, size };
  });
}

function normalizeActions(input, usedGroupMask) {
  if (!Array.isArray(input) || input.length > NCM4_ACTIONS.length) {
    throw new Error(`NCM4 actions must contain at most ${NCM4_ACTIONS.length} fixed clips.`);
  }
  const actions = input.map((action, index) => normalizeAction(action, index, usedGroupMask));
  actions.sort((a, b) => a.id - b.id);
  for (let index = 1; index < actions.length; index++) {
    if (actions[index - 1].id === actions[index].id) throw new Error(`Duplicate NCM4 action ${actions[index].name}.`);
  }
  return actions;
}

function normalizeAction(action, index, usedGroupMask) {
  if (!action || typeof action !== "object") throw new Error(`NCM4 action ${index} is invalid.`);
  const idSource = action.id ?? action.name ?? action.action;
  const id = resolveAction(idSource);
  const definition = ACTION_BY_ID.get(id);
  if (action.name != null && resolveAction(action.name) !== id) throw new Error(`NCM4 action ${index} has conflicting identity fields.`);
  if (action.ticksPerSecond != null && action.ticksPerSecond !== NCM4_TICKS_PER_SECOND) {
    throw new Error(`NCM4 actions use a fixed ${NCM4_TICKS_PER_SECOND} ticks per second.`);
  }
  const durationTicks = normalizeInteger(
    action.durationTicks ?? action.duration,
    `NCM4 ${definition.name} duration`,
    1,
    MAX_DURATION_TICKS,
  );
  const visibleGroupMask = normalizeVisibleGroupMask(action, usedGroupMask);
  const frameInput = action.keyframes ?? action.frames;
  if (!Array.isArray(frameInput) || frameInput.length < 1 || frameInput.length > MAX_KEYFRAMES) {
    throw new Error(`NCM4 ${definition.name} must contain 1 to ${MAX_KEYFRAMES} keyframes.`);
  }
  const keyframes = frameInput.map((frame, frameIndex) => normalizeKeyframe(frame, frameIndex, definition.name, durationTicks));
  for (let frameIndex = 1; frameIndex < keyframes.length; frameIndex++) {
    if (keyframes[frameIndex].tick <= keyframes[frameIndex - 1].tick) {
      throw new Error("NCM4 keyframe ticks must be strictly increasing.");
    }
  }
  if (action.loop != null && typeof action.loop !== "boolean") throw new Error("NCM4 action loop must be a boolean.");
  return {
    id,
    name: definition.name,
    durationTicks,
    loop: action.loop == null ? true : Boolean(action.loop),
    visibleGroupMask,
    keyframes,
  };
}

function normalizeVisibleGroupMask(action, usedGroupMask) {
  let mask = action.visibleGroupMask;
  let groupsMask;
  if (action.visibleGroups != null) {
    if (typeof action.visibleGroups === "number") {
      groupsMask = action.visibleGroups;
    } else if (Array.isArray(action.visibleGroups)) {
      groupsMask = 0;
      for (const group of action.visibleGroups) {
        groupsMask |= 1 << normalizeInteger(group, "NCM4 visible group", 0, MAX_GROUP);
      }
    } else {
      throw new Error("NCM4 visibleGroups must be a bit mask or an array of group IDs.");
    }
  }
  if (mask == null) mask = groupsMask ?? usedGroupMask;
  mask = normalizeInteger(mask, "NCM4 visible group mask", 1, MAX_VISIBLE_GROUP_MASK);
  if (groupsMask != null && groupsMask !== mask) throw new Error("NCM4 visible group fields conflict.");
  validateVisibleGroupMask(mask, usedGroupMask);
  return mask;
}

function normalizeKeyframe(frame, frameIndex, actionName, durationTicks) {
  if (!frame || typeof frame !== "object") throw new Error(`NCM4 ${actionName} keyframe ${frameIndex} is invalid.`);
  const tick = normalizeInteger(frame.tick, `NCM4 ${actionName} keyframe tick`, 0, durationTicks);
  if (frameIndex === 0 && tick !== 0) throw new Error("The first NCM4 keyframe must be at tick 0.");
  const rotationInput = frame.rotations;
  let entries;
  if (Array.isArray(rotationInput)) {
    entries = rotationInput;
  } else if (rotationInput && typeof rotationInput === "object") {
    entries = Object.entries(rotationInput).map(([bone, rotation]) => ({ bone, rotation }));
  } else {
    throw new Error(`NCM4 ${actionName} keyframe ${frameIndex} rotations are required.`);
  }
  if (entries.length < 1 || entries.length > NCM4_BONES.length) {
    throw new Error(`NCM4 keyframes must rotate 1 to ${NCM4_BONES.length} bones.`);
  }
  const rotations = entries.map((entry, rotationIndex) => {
    if (!entry || typeof entry !== "object") throw new Error(`NCM4 rotation ${rotationIndex} is invalid.`);
    const bone = resolveBone(entry.bone ?? entry.id ?? entry.name);
    const vector = normalizeVector(entry.rotation ?? [entry.x, entry.y, entry.z], "NCM4 Euler rotation", 3);
    const quantized = vector.map(quantizeRotation);
    return { bone, quantized };
  }).sort((a, b) => a.bone - b.bone);
  for (let index = 1; index < rotations.length; index++) {
    if (rotations[index - 1].bone === rotations[index].bone) throw new Error("NCM4 keyframe contains a duplicate bone rotation.");
  }
  return { tick, rotations };
}

function geometryBitWidths(model) {
  let maximumBone = 0;
  let maximumGroup = 0;
  let maximumX = 0;
  let maximumY = 0;
  let maximumZ = 0;
  let maximumW = 0;
  let maximumH = 0;
  let maximumD = 0;
  for (const cuboid of model.cuboids) {
    maximumBone = Math.max(maximumBone, cuboid.bone);
    maximumGroup = Math.max(maximumGroup, cuboid.group);
    maximumX = Math.max(maximumX, zigZagEncode(cuboid.origin[0]));
    maximumY = Math.max(maximumY, zigZagEncode(cuboid.origin[1]));
    maximumZ = Math.max(maximumZ, zigZagEncode(cuboid.origin[2]));
    maximumW = Math.max(maximumW, cuboid.size[0] - 1);
    maximumH = Math.max(maximumH, cuboid.size[1] - 1);
    maximumD = Math.max(maximumD, cuboid.size[2] - 1);
  }
  for (const action of model.actions) {
    for (const keyframe of action.keyframes) {
      for (const rotation of keyframe.rotations) maximumBone = Math.max(maximumBone, rotation.bone);
    }
  }
  return {
    bone: bitWidth(maximumBone),
    group: bitWidth(maximumGroup),
    x: bitWidth(maximumX),
    y: bitWidth(maximumY),
    z: bitWidth(maximumZ),
    w: bitWidth(maximumW),
    h: bitWidth(maximumH),
    d: bitWidth(maximumD),
  };
}

function validateStoredBitWidths(widths) {
  const limits = { bone: 5, group: 4, x: 16, y: 16, z: 16, w: 8, h: 8, d: 8 };
  for (const [name, value] of Object.entries(widths)) {
    if (value > limits[name]) throw new Error(`NCM4 ${name} bit width exceeds its safety bound.`);
  }
}

function validateVisibleGroupMask(mask, usedGroupMask) {
  if ((mask & 1) === 0) throw new Error("NCM4 action visibility must include body group 0.");
  if ((mask & ~usedGroupMask) !== 0) throw new Error("NCM4 action visibility references an unused geometry group.");
}

function readEnvelope(code) {
  const text = String(code ?? "");
  if (!text.startsWith(NCM4_PREFIX)) throw new Error("Expected a canonical NCM4 payload.");
  const encoded = text.slice(NCM4_PREFIX.length);
  if (encoded.length > Math.ceil(NCM4_MAX_PAYLOAD_BYTES * 4 / 3)) {
    throw new Error("NCM4 payload exceeds the on-chain safety limit.");
  }
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid canonical NCM4 Base64URL payload.");
  }
  let raw;
  try {
    raw = base64UrlDecode(encoded);
  } catch {
    throw new Error("Invalid canonical NCM4 Base64URL payload.");
  }
  if (base64UrlEncode(raw) !== encoded) throw new Error("Invalid canonical NCM4 Base64URL payload.");
  if (raw.length < 8) throw new Error("NCM4 payload is truncated.");
  if (raw.length > NCM4_MAX_PAYLOAD_BYTES) throw new Error("NCM4 payload exceeds the on-chain safety limit.");
  const body = raw.subarray(0, raw.length - 4);
  const storedChecksum = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(raw.length - 4, true);
  const actualChecksum = ncm4Crc32c(body);
  if (storedChecksum !== actualChecksum) throw new Error("NCM4 CRC32C checksum mismatch.");
  return { text, raw, body };
}

function createByteReader(raw) {
  let offset = 0;
  return {
    readByte(label = "data") {
      if (offset >= raw.length) throw new Error(`Unexpected end of NCM4 ${label}.`);
      return raw[offset++];
    },
    readBytes(count, label = "data") {
      if (!Number.isSafeInteger(count) || count < 0 || offset + count > raw.length) {
        throw new Error(`Unexpected end of NCM4 ${label}.`);
      }
      const value = raw.subarray(offset, offset + count);
      offset += count;
      return value;
    },
    readUVar(label = "varint") {
      const start = offset;
      let value = 0;
      let multiplier = 1;
      for (let index = 0; index < 5; index++) {
        const byte = this.readByte(label);
        value += (byte & 0x7f) * multiplier;
        if (value > 0xffffffff) throw new Error(`NCM4 ${label} varint is too large.`);
        if ((byte & 0x80) === 0) {
          if (offset - start !== uvarLength(value)) throw new Error(`NCM4 ${label} varint is not canonical.`);
          return value;
        }
        multiplier *= 128;
      }
      throw new Error(`NCM4 ${label} varint is too large.`);
    },
    readSVar(label = "signed varint") {
      return zigZagDecode(this.readUVar(label));
    },
    done() {
      return offset === raw.length;
    },
  };
}

function createBitWriter() {
  const bytes = [];
  let current = 0;
  let used = 0;
  return {
    write(value, bits) {
      if (bits === 0) return;
      for (let bit = 0; bit < bits; bit++) {
        current |= (Math.floor(value / (2 ** bit)) & 1) << used;
        used++;
        if (used === 8) {
          bytes.push(current);
          current = 0;
          used = 0;
        }
      }
    },
    finish() {
      if (used > 0) bytes.push(current);
      return bytes;
    },
  };
}

function createBitReader(raw) {
  let bitOffset = 0;
  return {
    read(bits) {
      let value = 0;
      for (let bit = 0; bit < bits; bit++) {
        if (bitOffset >= raw.length * 8) throw new Error("Unexpected end of NCM4 cuboid bitstream.");
        value += ((raw[bitOffset >> 3] >> (bitOffset & 7)) & 1) * (2 ** bit);
        bitOffset++;
      }
      return value;
    },
    assertCanonicalPadding() {
      while (bitOffset < raw.length * 8) {
        if ((raw[bitOffset >> 3] >> (bitOffset & 7)) & 1) throw new Error("NCM4 cuboid padding bits must be zero.");
        bitOffset++;
      }
    },
  };
}

function writeUVar(bytes, input) {
  let value = input;
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value > 0 ? 0x80 : 0));
  } while (value > 0);
}

function writeSVar(bytes, value) {
  writeUVar(bytes, zigZagEncode(value));
}

function readBoundedVar(reader, label, minimum, maximum) {
  const value = reader.readUVar(label);
  validateIntegerRange(value, `NCM4 ${label}`, minimum, maximum);
  return value;
}

function uvarLength(value) {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x200000) return 3;
  if (value < 0x10000000) return 4;
  return 5;
}

function zigZagEncode(value) {
  return value < 0 ? (-value * 2) - 1 : value * 2;
}

function zigZagDecode(value) {
  return value % 2 ? -((value + 1) / 2) : value / 2;
}

function bitWidth(maximum) {
  if (maximum <= 0) return 0;
  return Math.floor(Math.log2(maximum)) + 1;
}

function normalizeInteger(input, label, minimum, maximum) {
  const value = Number(input);
  validateIntegerRange(value, label, minimum, maximum);
  return value;
}

function validateIntegerRange(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function normalizeVector(input, label, length) {
  if (!Array.isArray(input) || input.length !== length) throw new Error(`${label} must contain ${length} values.`);
  return input.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} values must be finite numbers.`);
    return number;
  });
}

function normalizeColor(input) {
  const color = String(input ?? "").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error("NCM4 palette colors must use #rrggbb RGB notation.");
  return color;
}

function resolveBone(input) {
  const id = typeof input === "string" ? NCM4_BONE_IDS[input] : Number(input);
  if (!Number.isInteger(id) || id < 0 || id >= NCM4_BONES.length) throw new Error(`Unknown NCM4 bone ${String(input)}.`);
  return id;
}

function resolveAction(input) {
  const id = typeof input === "string" ? NCM4_ACTION_IDS[input] : Number(input);
  if (!ACTION_BY_ID.has(id)) throw new Error(`Unknown NCM4 action ${String(input)}.`);
  return id;
}

function quantizeRotation(input) {
  const value = Number(input);
  if (!Number.isFinite(value) || value < -Math.PI - 1e-9 || value > Math.PI + 1e-9) {
    throw new Error("NCM4 Euler rotations must be radians in the [-pi, pi] range.");
  }
  if (value >= Math.PI) return -128;
  return Math.max(-128, Math.min(127, Math.round(value / NCM4_ROTATION_STEP_RADIANS)));
}

function signedByte(value) {
  return value < 0 ? value + 256 : value;
}

function unsignedToSignedByte(value) {
  return value > 127 ? value - 256 : value;
}

function groupsFromMask(mask) {
  const groups = [];
  for (let group = 0; group <= MAX_GROUP; group++) if (mask & (1 << group)) groups.push(group);
  return groups;
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function base64UrlEncode(raw) {
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(raw).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  if (typeof atob === "function") return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function createCrc32cTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1;
    table[index] = crc >>> 0;
  }
  return table;
}
