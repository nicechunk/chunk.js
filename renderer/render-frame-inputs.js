const SOURCE_FIELDS = ['generation', 'chunkX', 'chunkZ', 'chunkSize', 'originY', 'minY', 'height',
  'meshVersion', 'visualMeshVersion', 'meshCommitToken', 'visualCommitToken',
  'renderSectionCommitRevision', 'renderActiveSections', 'renderSections', 'sections',
  'frustumCullEligible', 'buildingPreview'];
const MESH_FIELDS = ['originY', 'revision', 'commitToken', 'meshVersion', 'indexCount',
  'vertexCount', 'sectionSummary'];
const MESH_STORAGE_FIELDS = ['vertices', 'indices'];
const BOUNDS_FIELDS = ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'];
const SPHERE_FIELDS = ['centerX', 'centerY', 'centerZ', 'radius'];

// A prepared frame lives only between preparation and drawing. Managed columns
// publish a new revision and active list atomically; legacy mutable section maps
// deliberately take the defensive flatten/frustum path instead of trusting Map
// identity. The scalar record is reused and never examines vertex storage.
export class RenderFrameInputs {
  constructor() { this.values = []; this.input = null; this.reusable = false; }

  capture(input) {
    this.input = input;
    this.reusable = Array.isArray(input);
    let offset = 0;
    if (this.reusable) for (const source of input) {
      const sections = source?.renderSections ?? source?.sections;
      if (sections?.size && (source.renderSectionCommitRevision == null || !Array.isArray(source.renderActiveSections))) {
        this.reusable = false;
        break;
      }
      offset = visitSource(this.values, offset, source, true);
    }
    this.values.length = this.reusable ? offset : 0;
  }

  matches(input) {
    if (!this.reusable || input !== this.input) return false;
    let offset = 0;
    for (const source of input) {
      offset = visitSource(this.values, offset, source, false);
      if (offset < 0) return false;
    }
    return offset === this.values.length;
  }

  clear() { this.values.length = 0; this.input = null; this.reusable = false; }
}

function visitSource(values, offset, source, write) {
  offset = visitValue(values, offset, source, write);
  offset = visitFields(values, offset, source, SOURCE_FIELDS, write);
  offset = visitFields(values, offset, source?.renderBounds, BOUNDS_FIELDS, write);
  offset = visitFields(values, offset, source?.frustumBounds, SPHERE_FIELDS, write);
  offset = visitMesh(values, offset, source?.mesh, write);
  offset = visitMesh(values, offset, source?.visualMesh, write);
  return offset;
}

function visitValue(values, offset, value, write) {
  if (offset < 0) return -1;
  if (write) { values[offset] = value; return offset + 1; }
  return Object.is(values[offset], value) ? offset + 1 : -1;
}
function visitFields(values, offset, source, fields, write) {
  if (offset < 0) return -1;
  for (const key of fields) {
    offset = visitValue(values, offset, source?.[key], write);
    if (offset < 0) return -1;
  }
  return offset;
}
function visitMesh(values, offset, mesh, write) {
  offset = visitValue(values, offset, mesh, write);
  offset = visitFields(values, offset, mesh, MESH_FIELDS, write);
  const knownEmpty = mesh?.vertexCount === 0 || mesh?.indexCount === 0;
  // A managed summary exposes lazy whole-column vertices/indices for legacy
  // readers. Its immutable identity/revision/bounds are sufficient here; reading
  // those arrays would accidentally merge every section on the main thread.
  offset = visitFields(values, offset, mesh?.sectionSummary || knownEmpty ? null : mesh, MESH_STORAGE_FIELDS, write);
  return visitFields(values, offset, knownEmpty ? null : mesh?.bounds, BOUNDS_FIELDS, write);
}
