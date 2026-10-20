// Each authenticated on-chain section covers 16 x height x 16 local voxels.
// Cloning prevents a caller from mutating a queued Worker request.
export function snapshotBuildingDamage(sections = []) {
  if (!Array.isArray(sections) || sections.length > 256) throw new Error("Invalid building damage section count.");
  const seen = new Set();
  return sections.map(section => {
    const { sectionX, sectionZ, sizeY } = section ?? {};
    if (![sectionX, sectionZ].every(v => Number.isInteger(v) && v >= 0 && v < 16)
        || !Number.isInteger(sizeY) || sizeY < 1 || sizeY > 256) throw new Error("Invalid building damage coordinates.");
    const key = sectionX * 16 + sectionZ;
    if (seen.has(key)) throw new Error("Duplicate building damage section.");
    seen.add(key);
    const bitmap = Uint8Array.from(section.bitmap ?? []);
    if (bitmap.length !== sizeY * 32) throw new Error("Invalid building damage bitmap length.");
    return { sectionX, sectionZ, sizeY, bitmap };
  });
}

export function buildingDamageLookup(sections, size) {
  const lookup = new Map();
  for (const section of snapshotBuildingDamage(sections)) {
    if (section.sizeY !== size.y || section.sectionX * 16 >= size.x || section.sectionZ * 16 >= size.z) {
      throw new Error("Building damage does not match its NCM dimensions.");
    }
    lookup.set(section.sectionX * 16 + section.sectionZ, section.bitmap);
  }
  return (x, y, z) => {
    const bitmap = lookup.get(Math.floor(x / 16) * 16 + Math.floor(z / 16));
    if (!bitmap) return false;
    const bit = (y * 16 + z % 16) * 16 + x % 16;
    return Boolean(bitmap[bit >>> 3] & (1 << (bit & 7)));
  };
}
