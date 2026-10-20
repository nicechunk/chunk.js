// NCM ids describe render materials. Inventory ids describe reclaimable system
// resources; processed finishes recover their underlying material, one standard
// resource unit per removed voxel. In particular NCM 55 is wood, not loose stone.
export function buildingResourceBlockId(material) {
  if (!Number.isInteger(material)) return 0;
  if (material>=1&&material<=47) return material===16?3:material;
  if (material>=48&&material<=52) return material+1;
  if (material>=55&&material<=57) return 22;
  if (material>=58&&material<=61) return 5;
  return ({62:7,63:7,64:3,65:4,66:14,67:5,68:6,69:3,70:3,71:7,72:2,73:46,74:7,75:7,76:15,77:10,
    96:7,97:5,98:46,99:47,100:15,101:40})[material]??0;
}
