// CPU double precision origin reduction. GPU sees bounded local floats and integer cells.
export const WATER_CELL_SIZES = Object.freeze([1/1.35,1/0.42,1/0.038,0.52,0.86,1.42]);
export function positiveModulo(value,modulus){return ((value%modulus)+modulus)%modulus;}
export function waterPrecisionUniforms(origin){const phase=new Float32Array(12),cells=new Int32Array(12);for(let i=0;i<WATER_CELL_SIZES.length;i++){const size=WATER_CELL_SIZES[i];for(let k=0;k<2;k++){const world=k===0?origin.worldX:origin.worldZ;const grid=world/size;const whole=Math.floor(grid);cells[i*2+k]=whole;phase[i*2+k]=grid-whole;}}return {originPhase:[positiveModulo(origin.worldX,256),positiveModulo(origin.worldZ,256)],cellOrigins:cells,cellPhases:phase};}
export function waterCellAt(world,origin,size){const grid=origin/size;const base=Math.floor(grid);const local=(world-origin)/size+(grid-base);return {cell:base+Math.floor(local),fraction:local-Math.floor(local)};}
