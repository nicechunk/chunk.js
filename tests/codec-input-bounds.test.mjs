import assert from "node:assert/strict";

import {
  NCF1_MAX_RAW_BYTES,
  NCF1_PREFIX,
  NCF1_VERSION,
  Ncf1ValidationError,
  createForgeDesign,
  decodeNcf1,
  decodeNcf1EquipmentHeader,
  encodeNcf1,
  encodeNcf1Bytes,
  forgeBytesToCode,
  forgeCodeToBytes,
  validateNcf1,
} from "../forge/forge-core.js";

const validDesign = createForgeDesign();
const validBytes = encodeNcf1Bytes(validDesign);
const validCode = encodeNcf1(validDesign);
assert.equal(decodeNcf1(validCode, { requireCanonical: true }).version, NCF1_VERSION);
assert.equal(decodeNcf1EquipmentHeader(validBytes).version, NCF1_VERSION);

const smallBytes = Uint8Array.from([1, 2, 3]);
assert.deepEqual(forgeCodeToBytes(smallBytes), smallBytes);
assert.deepEqual(forgeCodeToBytes(smallBytes.buffer), smallBytes);
assert.deepEqual(
  forgeCodeToBytes(new DataView(smallBytes.buffer, smallBytes.byteOffset, smallBytes.byteLength)),
  smallBytes,
);
assert.deepEqual(forgeCodeToBytes([1, 2, 3]), smallBytes);
assert.deepEqual(forgeCodeToBytes({ bytes: smallBytes }), smallBytes);
assert.deepEqual(forgeCodeToBytes({ code: forgeBytesToCode(smallBytes) }), smallBytes);

let bytesGetterReads = 0;
let codeGetterReads = 0;
const bytesGetterWrapper = {
  get bytes() {
    bytesGetterReads += 1;
    return smallBytes;
  },
  get code() {
    codeGetterReads += 1;
    throw new Error("code getter must not be read when bytes are present");
  },
};
assert.deepEqual(forgeCodeToBytes(bytesGetterWrapper), smallBytes);
assert.equal(bytesGetterReads, 1, "wrapper bytes getters must be read at most once");
assert.equal(codeGetterReads, 0, "wrapper code getters must not be read when bytes are present");

bytesGetterReads = 0;
codeGetterReads = 0;
const codeGetterWrapper = {
  get bytes() {
    bytesGetterReads += 1;
    return null;
  },
  get code() {
    codeGetterReads += 1;
    return forgeBytesToCode(smallBytes);
  },
};
assert.deepEqual(forgeCodeToBytes(codeGetterWrapper), smallBytes);
assert.equal(bytesGetterReads, 1, "wrapper bytes getters must be read at most once before code fallback");
assert.equal(codeGetterReads, 1, "wrapper code getters must be read at most once");

const alternateBytes = encodeNcf1Bytes(createForgeDesign({ component: { resourceId: "copper" } }));
assert.notDeepEqual(alternateBytes, validBytes, "stateful validation snapshots must use distinct fixtures");
let validationGetterReads = 0;
const statefulValidationWrapper = {
  get bytes() {
    validationGetterReads += 1;
    return validationGetterReads === 1 ? validBytes : alternateBytes;
  },
};
const validatedSnapshot = validateNcf1(statefulValidationWrapper, { requireCanonical: true });
assert.equal(validatedSnapshot.ok, true);
assert.equal(validationGetterReads, 1, "validation must snapshot wrapper input exactly once");
assert.deepEqual(validatedSnapshot.design, decodeNcf1(validBytes, { requireCanonical: true }));
assert.deepEqual(validatedSnapshot.bytes, validBytes);
assert.equal(validatedSnapshot.code, forgeBytesToCode(validBytes));

const exactLimitBytes = new Uint8Array(NCF1_MAX_RAW_BYTES);
const exactLimitCode = forgeBytesToCode(exactLimitBytes);
assert.equal(exactLimitCode.slice(NCF1_PREFIX.length).length, 854);
assert.equal(forgeCodeToBytes(exactLimitBytes).length, NCF1_MAX_RAW_BYTES);
assert.equal(forgeCodeToBytes(exactLimitCode).length, NCF1_MAX_RAW_BYTES);
assert.equal(forgeCodeToBytes(exactLimitCode, { maxBytes: "640" }).length, NCF1_MAX_RAW_BYTES);

const oversizedBytes = new Uint8Array(NCF1_MAX_RAW_BYTES + 1);
for (const decode of [
  () => forgeCodeToBytes(oversizedBytes),
  () => forgeBytesToCode(oversizedBytes),
  () => forgeCodeToBytes(oversizedBytes.buffer),
  () => forgeCodeToBytes({ bytes: oversizedBytes }),
  () => decodeNcf1(oversizedBytes),
  () => decodeNcf1EquipmentHeader(oversizedBytes),
]) {
  assert.throws(decode, codeTooLarge);
}

const oversizedArray = new Array(NCF1_MAX_RAW_BYTES + 1).fill(0);
Object.defineProperty(oversizedArray, 0, {
  get() {
    throw new Error("oversized array elements must not be read");
  },
});
assert.throws(() => forgeCodeToBytes(oversizedArray), codeTooLarge);
assert.throws(() => forgeCodeToBytes([256]), /between 0 and 255/);

let iteratorReads = 0;
const customIteratorArray = [1, 2, 3];
customIteratorArray[Symbol.iterator] = () => ({
  next() {
    iteratorReads += 1;
    if (iteratorReads > NCF1_MAX_RAW_BYTES + 1) {
      throw new Error("unbounded array iterator was consumed");
    }
    return { done: false, value: 0 };
  },
});
assert.deepEqual(
  forgeCodeToBytes(customIteratorArray),
  smallBytes,
  "plain-array conversion must use the validated indexed length rather than a custom iterator",
);
assert.equal(iteratorReads, 0, "plain-array conversion must never invoke a caller-provided iterator");

const cyclicWrapper = {};
cyclicWrapper.bytes = cyclicWrapper;
assert.throws(
  () => forgeCodeToBytes(cyclicWrapper),
  (error) => error instanceof Ncf1ValidationError && error.code === "invalid-code-input",
);

const oversizedCode = `${NCF1_PREFIX}${"A".repeat(855)}`;
const originalAtob = globalThis.atob;
let atobCalls = 0;
globalThis.atob = () => {
  atobCalls += 1;
  throw new Error("oversized Base64URL must not be decoded");
};
try {
  assert.throws(() => forgeCodeToBytes(oversizedCode), codeTooLarge);
  assert.throws(() => decodeNcf1(oversizedCode), codeTooLarge);
  assert.throws(() => decodeNcf1EquipmentHeader(oversizedCode), codeTooLarge);
  assert.throws(() => forgeCodeToBytes({ code: oversizedCode }), codeTooLarge);
  assert.equal(atobCalls, 0, "oversized NCF1 text must be rejected before Base64 decoding");
} finally {
  if (originalAtob === undefined) delete globalThis.atob;
  else globalThis.atob = originalAtob;
}

assert.equal(
  decodeNcf1EquipmentHeader(validBytes, { maxBytes: validBytes.length }).version,
  NCF1_VERSION,
);
assert.throws(
  () => decodeNcf1EquipmentHeader(validBytes, { maxBytes: validBytes.length - 1 }),
  codeTooLarge,
);
assert.throws(() => forgeCodeToBytes(smallBytes, { maxBytes: 2 }), codeTooLarge);
for (const maxBytes of [0, NCF1_MAX_RAW_BYTES + 1, 1.5, Infinity, NaN]) {
  assert.throws(
    () => decodeNcf1EquipmentHeader(validBytes, { maxBytes }),
    invalidByteLimit,
  );
  assert.throws(
    () => forgeCodeToBytes(validBytes, { maxBytes }),
    invalidByteLimit,
  );
}

function codeTooLarge(error) {
  return error instanceof Ncf1ValidationError && error.code === "code-too-large";
}

function invalidByteLimit(error) {
  return error instanceof Ncf1ValidationError
    && (error.code === "invalid-integer" || error.code === "integer-out-of-range");
}

console.log("Codec input bound tests passed");
