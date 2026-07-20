const DEFAULT_TICKS_PER_SECOND = 30;

export function sampleNcm4Action(actions, animation = {}) {
  const action = resolveNcm4Action(actions, animation.action ?? animation.actionId ?? animation.clip);
  if (!action) {
    return {
      action: null,
      tick: 0,
      progress: 0,
      rotations: new Map(),
      visibleGroupMask: 1,
    };
  }

  const durationTicks = actionDurationTicks(action);
  const ticksPerSecond = positiveNumber(action.ticksPerSecond ?? action.fps, DEFAULT_TICKS_PER_SECOND);
  const loop = animation.loop ?? action.loop ?? true;
  const requestedProgress = finiteNumber(animation.progress ?? animation.actionProgress);
  let tick;
  if (requestedProgress !== null) {
    const progress = clamp(requestedProgress, 0, 1);
    tick = progress * durationTicks;
  } else {
    const elapsedMs = finiteNumber(
      animation.elapsedMs ?? animation.actionElapsedMs ?? animation.timeMs,
      0,
    );
    tick = (elapsedMs / 1_000) * ticksPerSecond;
    tick = loop ? positiveModulo(tick, durationTicks) : clamp(tick, 0, durationTicks);
  }

  const rotations = new Map();
  const tracks = actionRotationTracks(action);
  for (const [bone, track] of tracks) {
    rotations.set(bone, sampleRotationTrack(track, tick, durationTicks, Boolean(loop)));
  }
  return {
    action,
    tick,
    progress: durationTicks > 0 ? tick / durationTicks : 0,
    rotations,
    visibleGroupMask: actionVisibleGroupMask(action),
  };
}

export function resolveNcm4Action(actions, selection) {
  const source = Array.isArray(actions) ? actions : [];
  if (!source.length || selection === null || selection === undefined || selection === "") return null;
  if (typeof selection === "object" && selection) return selection;
  const wanted = String(selection).toLowerCase();
  return source.find((action, index) => (
    String(action?.id ?? index).toLowerCase() === wanted
    || String(action?.name ?? "").toLowerCase() === wanted
    || String(action?.key ?? "").toLowerCase() === wanted
  )) ?? null;
}

export function ncm4PartGroupVisible(group, visibleGroupMask = 1) {
  const normalizedGroup = Math.max(0, Math.min(31, Math.trunc(Number(group) || 0)));
  if (normalizedGroup === 0) return true;
  return Boolean((visibleGroupMask >>> normalizedGroup) & 1);
}

export function ncm4RotationForBone(rotations, bone) {
  if (!(rotations instanceof Map)) return ZERO_ROTATION;
  const candidates = [bone?.id, bone?.name, bone?.index]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value));
  for (const candidate of candidates) {
    const rotation = rotations.get(candidate) ?? rotations.get(Number(candidate));
    if (rotation) return rotation;
  }
  return ZERO_ROTATION;
}

function actionDurationTicks(action) {
  const explicit = positiveNumber(action.durationTicks ?? action.ticks, null);
  if (explicit !== null) return explicit;
  const duration = positiveNumber(action.duration, null);
  if (duration !== null) return duration;
  const frames = Array.isArray(action.keyframes) ? action.keyframes : action.frames;
  const lastTick = Array.isArray(frames)
    ? frames.reduce((maximum, frame) => Math.max(maximum, finiteNumber(frame?.tick ?? frame?.time, 0)), 0)
    : 0;
  return Math.max(1, lastTick);
}

function actionVisibleGroupMask(action) {
  const explicit = finiteNumber(action.visibleGroupMask ?? action.groupMask);
  if (explicit !== null) return (Math.trunc(explicit) | 1) >>> 0;
  if (Array.isArray(action.visibleGroups)) {
    let mask = 1;
    for (const group of action.visibleGroups) {
      const index = Math.trunc(Number(group));
      if (index >= 0 && index < 32) mask = (mask | (1 << index)) >>> 0;
    }
    return mask;
  }
  return 1;
}

function actionRotationTracks(action) {
  const tracks = new Map();
  const frames = Array.isArray(action.keyframes) ? action.keyframes : action.frames;
  if (!Array.isArray(frames)) return tracks;
  for (const frame of frames) {
    const tick = Math.max(0, finiteNumber(frame?.tick ?? frame?.time, 0));
    for (const entry of frameRotations(frame)) {
      const key = String(entry.bone);
      const track = tracks.get(key) ?? [];
      track.push({ tick, rotation: normalizeRotation(entry.rotation) });
      tracks.set(key, track);
    }
  }
  for (const track of tracks.values()) track.sort((left, right) => left.tick - right.tick);
  return tracks;
}

function frameRotations(frame) {
  const source = frame?.rotations ?? frame?.bones ?? frame?.pose;
  if (Array.isArray(source)) {
    return source
      .map((entry, index) => ({
        bone: entry?.bone ?? entry?.boneId ?? entry?.id ?? index,
        rotation: entry?.rotation ?? entry?.euler ?? entry?.r,
      }))
      .filter((entry) => Array.isArray(entry.rotation));
  }
  if (source && typeof source === "object") {
    return Object.entries(source)
      .map(([bone, rotation]) => ({ bone, rotation: rotation?.rotation ?? rotation?.euler ?? rotation }))
      .filter((entry) => Array.isArray(entry.rotation));
  }
  return [];
}

function sampleRotationTrack(sourceTrack, tick, durationTicks, loop) {
  if (!sourceTrack.length) return ZERO_ROTATION;
  const track = sourceTrack[0].tick > 0
    ? [{ tick: 0, rotation: ZERO_ROTATION }, ...sourceTrack]
    : sourceTrack;
  if (track.length === 1) return track[0].rotation;

  for (let index = 1; index < track.length; index += 1) {
    const next = track[index];
    if (tick > next.tick) continue;
    const previous = track[index - 1];
    const span = Math.max(1e-6, next.tick - previous.tick);
    return interpolateRotation(previous.rotation, next.rotation, clamp((tick - previous.tick) / span, 0, 1));
  }

  const last = track[track.length - 1];
  if (!loop || durationTicks <= last.tick) return last.rotation;
  const first = track[0];
  const span = Math.max(1e-6, durationTicks - last.tick + first.tick);
  return interpolateRotation(last.rotation, first.rotation, clamp((tick - last.tick) / span, 0, 1));
}

function interpolateRotation(left, right, amount) {
  return {
    x: interpolateAngle(left.x, right.x, amount),
    y: interpolateAngle(left.y, right.y, amount),
    z: interpolateAngle(left.z, right.z, amount),
  };
}

function interpolateAngle(left, right, amount) {
  const delta = positiveModulo(right - left + Math.PI, Math.PI * 2) - Math.PI;
  return left + delta * amount;
}

function normalizeRotation(value) {
  return {
    x: finiteNumber(value?.[0], 0),
    y: finiteNumber(value?.[1], 0),
    z: finiteNumber(value?.[2], 0),
  };
}

function positiveModulo(value, divisor) {
  if (!(divisor > 0)) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

const ZERO_ROTATION = Object.freeze({ x: 0, y: 0, z: 0 });
