const DEFAULT_MAX_ENTRIES = 1600;

export class RenderLog {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.maxEntries = Math.max(100, Math.trunc(maxEntries || DEFAULT_MAX_ENTRIES));
    this.enabled = false;
    this.entries = [];
    this.sequence = 1;
    this.frame = 0;
    this.startedAt = nowMs();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled && !this.startedAt) this.startedAt = nowMs();
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  clear() {
    this.entries.length = 0;
    this.sequence = 1;
    this.startedAt = nowMs();
  }

  beginFrame(meta = {}) {
    if (!this.enabled) return 0;
    this.frame += 1;
    if (meta && Object.keys(meta).length) this.record("frame", { frame: this.frame, ...meta });
    return this.frame;
  }

  record(type, data = {}) {
    if (!this.enabled) return null;
    const entry = {
      seq: this.sequence++,
      at: nowMs(),
      sinceStartMs: nowMs() - this.startedAt,
      type: String(type || "event"),
      ...data,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return entry;
  }

  count() {
    return this.entries.length;
  }

  recent(limit = 12) {
    const size = Math.max(0, Math.trunc(limit || 0));
    return size ? this.entries.slice(-size) : [];
  }

  summary({ limit = 5 } = {}) {
    if (!this.enabled) return "OFF";
    if (!this.entries.length) return "ON · waiting for chunk events";
    const frames = topEntries(this.entries, (entry) => entry.type === "frame-long-task", "elapsedMs", limit);
    const build = topEntries(this.entries, (entry) => entry.type === "chunk-build-done" || entry.type === "chunk-build-sync" || entry.type === "visual-build-done", "elapsedMs", limit);
    const upload = topEntries(this.entries, (entry) => entry.type === "chunk-upload" || entry.type === "region-upload", "elapsedMs", limit);
    const draw = topEntries(this.entries, (entry) => entry.type === "chunk-draw" || entry.type === "region-draw", "elapsedMs", limit);
    return [
      `ON · ${this.entries.length}/${this.maxEntries} entries`,
      compactLine("Frame", frames),
      compactLine("Build", build),
      compactLine("Upload", upload),
      compactLine("Draw CPU", draw),
    ].filter(Boolean).join("\n");
  }

  toText({ limit = this.entries.length } = {}) {
    const entries = limit >= this.entries.length ? this.entries : this.entries.slice(-Math.max(1, Math.trunc(limit || 1)));
    const header = [
      "NiceChunk render log",
      `enabled=${this.enabled}`,
      `entries=${this.entries.length}`,
      `exportedAt=${new Date().toISOString()}`,
      "note=draw timings are CPU-side WebGL call timings; region batches list covered chunks and per-chunk estimates.",
      "",
    ].join("\n");
    return header + entries.map(formatEntry).join("\n");
  }
}

function topEntries(entries, predicate, field, limit) {
  return entries
    .filter((entry) => predicate(entry) && Number.isFinite(entry[field]))
    .slice()
    .sort((a, b) => b[field] - a[field])
    .slice(0, Math.max(1, Math.trunc(limit || 1)));
}

function compactLine(label, entries) {
  if (!entries.length) return `${label}: -`;
  return `${label}: ${entries.map((entry) => `${entryLabel(entry)} ${fmtMs(entry.elapsedMs)}`).join(" · ")}`;
}

function formatEntry(entry) {
  const parts = [
    `#${entry.seq}`,
    `+${fmtMs(entry.sinceStartMs, 1)}`,
    entry.type,
  ];
  append(parts, "frame", entry.frame);
  append(parts, "chunk", entry.chunkId || chunkLabel(entry));
  append(parts, "region", entry.regionId);
  append(parts, "mesh", entry.meshType);
  append(parts, "elapsed", fmtMs(entry.elapsedMs));
  append(parts, "dt", fmtMs(entry.dtMs));
  append(parts, "wait", fmtMs(entry.waitMs));
  append(parts, "total", fmtMs(entry.totalMs));
  append(parts, "base", fmtMs(entry.baseMs));
  append(parts, "trees", fmtMs(entry.treeMs));
  append(parts, "opaque", fmtMs(entry.opaqueMeshMs));
  append(parts, "visual", fmtMs(entry.visualMeshMs));
  append(parts, "tris", entry.triangles);
  append(parts, "bytes", entry.bytes);
  append(parts, "queue", entry.queueLength);
  append(parts, "covered", entry.chunkIds?.join?.(" "));
  append(parts, "estimate", entry.estimatedChunkMs ? formatEstimates(entry.estimatedChunkMs) : null);
  append(parts, "segments", entry.slowSegments);
  append(parts, "error", entry.error);
  return parts.filter(Boolean).join(" | ");
}

function append(parts, label, value) {
  if (value === null || value === undefined || value === "") return;
  parts.push(`${label}=${value}`);
}

function entryLabel(entry) {
  return entry.chunkId || entry.regionId || chunkLabel(entry) || "-";
}

function chunkLabel(entry) {
  if (Number.isFinite(entry.chunkX) && Number.isFinite(entry.chunkZ)) return `${entry.chunkX},${entry.chunkZ}`;
  return "";
}

function formatEstimates(estimates) {
  if (!Array.isArray(estimates)) return "";
  return estimates.slice(0, 10).map((item) => `${item.id}:${fmtMs(item.ms)}`).join(",");
}

function fmtMs(value, digits = 2) {
  return Number.isFinite(value) ? `${Number(value).toFixed(digits)}ms` : "";
}

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
