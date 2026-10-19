// RPC response context is a bank watermark, never an account write version.
// Local confirmations are kept briefly while a finalized replacement catches up.
export const CONFIRMED_DELTA_PROTECTION_MS = 30_000;
export const REMOTE_DELTA_TTL_MS = 5_000;

export function optionalSnapshotSlot(value, label = "Snapshot slot") {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer or null when unknown.`);
  return value;
}

export function confirmationProtection(options = {}, now = Date.now()) {
  const executionSlot = optionalSnapshotSlot(options.executionSlot ?? options.slot, "Transaction execution slot");
  const commitment = options.commitment === "finalized" ? "finalized" : options.commitment === "confirmed" ? "confirmed" : "unknown";
  return {
    executionSlot,
    commitment,
    signature: String(options.signature || ""),
    confirmedAt: now,
    expiresAt: now + CONFIRMED_DELTA_PROTECTION_MS,
  };
}

export function mayReplaceProtectedDelta(protection, { snapshotSlot, snapshotCommitment, source, readStartedAt, now }) {
  if (source !== "rpc") return false;
  if (protection.executionSlot !== null && (snapshotSlot === null || snapshotSlot < protection.executionSlot)) return false;
  // A later context slot alone does not establish fork identity or same-slot write
  // order. A finalized bank read started after confirmation is the authoritative
  // convergence path; confirmed-only endpoints get a bounded grace period.
  if (protection.executionSlot !== null && snapshotCommitment === "finalized" && readStartedAt >= protection.confirmedAt) return true;
  return now >= protection.expiresAt
    && readStartedAt >= protection.expiresAt
    && snapshotSlot !== null
    && (snapshotCommitment === "confirmed" || snapshotCommitment === "finalized");
}
