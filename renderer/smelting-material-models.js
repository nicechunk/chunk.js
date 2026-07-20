const MODEL_CACHE_LIMIT = 96;
const modelCache = new Map();
const surfaceProfileCache = new Map();

export const SMELTING_MATERIAL_VISUAL_REVISION = "nicechunk-smelting-material-visuals-v2";

const MODEL_DEFS = Object.freeze({
  charcoal: model({
    name: "Charcoal",
    className: "carbon",
    shape: "fractured fuel chunks",
    roughness: 0.98,
    description: "Three carbonized wood chunks with split faces and a restrained ember seam.",
    build(builder) {
      rubble(builder, [36, 34, 32, 255], [64, 55, 42, 255], { ember: [178, 76, 32, 255] });
    },
  }),
  biochar_compost: model({
    name: "Biochar Compost",
    className: "carbon",
    shape: "amended soil tray",
    roughness: 1,
    description: "A shallow biochar bed with carbon granules and visible moss nutrient flecks.",
    build(builder) {
      builder.box(0, 0.09, 0, 0.84, 0.18, 0.62, [92, 68, 47, 255]);
      builder.box(0, 0.20, 0, 0.72, 0.13, 0.52, [47, 42, 34, 255]);
      specks(builder, [
        [-0.22, 0.30, 0.10, [91, 132, 67, 255]],
        [0.18, 0.29, -0.12, [68, 103, 53, 255]],
        [0.03, 0.31, 0.16, [122, 94, 53, 255]],
        [0.29, 0.30, 0.08, [37, 35, 31, 255]],
      ], 0.11);
    },
  }),
  resin_binder: model({
    name: "Resin Binder",
    className: "polymer",
    shape: "sealed resin flask",
    roughness: 0.46,
    translucency: 0.16,
    description: "A compact sealed flask with a warm amber resin core and pine-dark cap.",
    build(builder) {
      jar(builder, [205, 118, 40, 220], [247, 172, 61, 238], [79, 61, 42, 255]);
    },
  }),
  ceramic_brick: model({
    name: "Ceramic Brick",
    className: "ceramic",
    shape: "fired brick stack",
    roughness: 0.94,
    description: "Two offset fired-clay bricks with dark kiln seams and chipped highlights.",
    build(builder) {
      brickStack(builder, [184, 103, 65, 255], [113, 65, 48, 255], [222, 143, 91, 255]);
    },
  }),
  lime_ceramic: model({
    name: "Lime Ceramic",
    className: "ceramic",
    shape: "refractory tile stack",
    roughness: 0.88,
    description: "Pale refractory tiles with a warm clay core and lime-rich face band.",
    build(builder) {
      tileStack(builder, [224, 215, 180, 255], [185, 151, 105, 255], [247, 239, 207, 255]);
    },
  }),
  quicklime: model({
    name: "Quicklime",
    className: "ceramic",
    shape: "calcined lime chunks",
    roughness: 1,
    description: "An irregular pile of chalk-white calcined shell and coral fragments.",
    build(builder) {
      rubble(builder, [230, 224, 202, 255], [177, 173, 155, 255], { accent: [249, 246, 226, 255] });
    },
  }),
  salt_flux: model({
    name: "Salt Flux",
    className: "chemical",
    shape: "flux crystal cluster",
    roughness: 0.72,
    translucency: 0.08,
    description: "A pale salt-and-ash crystal cluster sized to remain readable in a backpack slot.",
    build(builder) {
      crystalCluster(builder, [202, 222, 194, 236], [244, 244, 218, 250], [137, 152, 128, 255]);
    },
  }),
  ash_cement: model({
    name: "Ash Cement",
    className: "composite",
    shape: "compressed binder sack",
    roughness: 1,
    description: "A compact ash-cement sack with a folded top and a mineral batch mark.",
    build(builder) {
      builder.box(0, 0.30, 0, 0.64, 0.58, 0.42, [124, 118, 108, 255]);
      builder.box(0, 0.62, 0, 0.46, 0.12, 0.30, [90, 86, 80, 255], { z: 0.08 });
      builder.box(0, 0.34, 0.222, 0.30, 0.18, 0.025, [190, 162, 102, 255]);
      builder.box(0, 0.12, 0.228, 0.48, 0.045, 0.03, [74, 72, 69, 255]);
    },
  }),
  glass_ingot: model({
    name: "Glass Ingot",
    className: "glass",
    shape: "clear cast glass stock",
    roughness: 0.18,
    translucency: 0.44,
    description: "A cyan cast-glass ingot with a clear center, thick rim, and cooled surface highlight.",
    build(builder) {
      glassIngot(builder, [84, 190, 220, 164], [175, 238, 249, 220], [42, 119, 151, 215]);
    },
  }),
  obsidian_glass: model({
    name: "Obsidian Glass",
    className: "glass",
    shape: "volcanic glass shard",
    roughness: 0.24,
    translucency: 0.10,
    description: "A stepped black volcanic-glass shard with violet edge reflections and a basalt foot.",
    build(builder) {
      builder.box(0, 0.08, 0, 0.72, 0.16, 0.48, [43, 42, 48, 255]);
      builder.box(-0.13, 0.37, 0.02, 0.26, 0.62, 0.22, [35, 31, 48, 238], { z: -0.19, y: 0.10 });
      builder.box(0.13, 0.31, -0.04, 0.22, 0.50, 0.19, [62, 49, 79, 232], { z: 0.22, y: -0.16 });
      builder.box(-0.20, 0.43, 0.14, 0.035, 0.36, 0.035, [153, 110, 190, 225], { z: -0.19 });
    },
  }),
  silicon_wafer: model({
    name: "Silicon Wafer",
    className: "crystal",
    shape: "etched circuit wafer",
    roughness: 0.22,
    description: "A thin blue silicon wafer with etched conductive lanes and contact pads.",
    build(builder) {
      builder.box(0, 0.08, 0, 0.78, 0.10, 0.64, [55, 104, 150, 255]);
      builder.box(0, 0.145, 0, 0.68, 0.035, 0.54, [77, 155, 192, 255]);
      circuitTrace(builder, [223, 180, 71, 255]);
    },
  }),
  ice_crystal: model({
    name: "Ice Crystal",
    className: "crystal",
    shape: "stabilized ice cluster",
    roughness: 0.20,
    translucency: 0.42,
    emissive: [0.03, 0.10, 0.14],
    description: "A salt-stabilized cluster of translucent ice blades on a frosted base.",
    build(builder) {
      crystalCluster(builder, [105, 200, 239, 182], [205, 247, 255, 232], [91, 150, 192, 226]);
    },
  }),
  iron_bloom: model({
    name: "Iron Bloom",
    className: "metal",
    shape: "slag-bearing metal bloom",
    roughness: 0.78,
    description: "A rough iron bloom with compact metallic nodes and a small retained slag seam.",
    build(builder) {
      metalBloom(builder, [119, 126, 132, 255], [190, 198, 201, 255], [111, 65, 39, 255]);
    },
  }),
  copper_bloom: model({
    name: "Copper Bloom",
    className: "metal",
    shape: "copper metal bloom",
    roughness: 0.64,
    description: "A warm copper bloom with bright reduced faces and restrained green oxide traces.",
    build(builder) {
      metalBloom(builder, [172, 91, 52, 255], [224, 138, 77, 255], [57, 126, 111, 255]);
    },
  }),
  alumina_plate: model({
    name: "Alumina Plate",
    className: "ceramic",
    shape: "insulating ceramic plate",
    roughness: 0.70,
    description: "A pale impact plate with a recessed center, dark ceramic edge, and four mounting pads.",
    build(builder) {
      technicalPlate(builder, [216, 222, 217, 255], [153, 164, 169, 255], [244, 246, 235, 255]);
    },
  }),
  nickel_iron: model({
    name: "Nickel Iron",
    className: "alloy",
    shape: "magnetic alloy bar",
    roughness: 0.44,
    description: "A polished nickel-iron bar with dark magnetic end bands and a cool central highlight.",
    build(builder) {
      alloyBar(builder, [151, 169, 179, 255], [214, 226, 230, 255], [65, 78, 88, 255]);
    },
  }),
  carbon_plate: model({
    name: "Carbon Plate",
    className: "carbon",
    shape: "layered carbon laminate",
    roughness: 0.82,
    description: "Three compressed carbon laminates with a visible crossed fiber weave.",
    build(builder) {
      layeredPlate(builder, [42, 45, 47, 255], [76, 82, 84, 255], [112, 120, 120, 255]);
    },
  }),
  carbon_steel: model({
    name: "Carbon Steel",
    className: "alloy",
    shape: "quenched steel billet",
    roughness: 0.48,
    description: "A dense quenched steel billet with a dark carbon core and bright worked edges.",
    build(builder) {
      alloyBar(builder, [91, 104, 113, 255], [196, 207, 210, 255], [37, 42, 47, 255]);
      builder.box(0, 0.43, 0.22, 0.48, 0.035, 0.025, [226, 150, 68, 255]);
    },
  }),
  basalt_fiber: model({
    name: "Basalt Fiber",
    className: "fiber",
    shape: "volcanic fiber spool",
    roughness: 0.88,
    description: "A low-poly spool of pulled basalt strands with a faint heat-worked rim.",
    build(builder) {
      fiberSpool(builder, [59, 64, 72, 255], [113, 119, 126, 255], [211, 104, 45, 255]);
    },
  }),
  basalt_composite: model({
    name: "Basalt Composite",
    className: "composite",
    shape: "reinforced armor panel",
    roughness: 0.84,
    description: "A dark basalt composite panel with carbon ribs and resin-sealed corner fasteners.",
    build(builder) {
      technicalPlate(builder, [59, 75, 75, 255], [31, 42, 47, 255], [103, 151, 132, 255]);
    },
  }),
  geopolymer_block: model({
    name: "Geopolymer Block",
    className: "composite",
    shape: "interlocking masonry block",
    roughness: 0.98,
    description: "An ash-and-basalt masonry block with an interlocking top key and salt-activated seam.",
    build(builder) {
      builder.box(0, 0.28, 0, 0.82, 0.50, 0.58, [105, 111, 103, 255]);
      builder.box(-0.22, 0.58, 0, 0.25, 0.10, 0.30, [137, 142, 128, 255]);
      builder.box(0.22, 0.58, 0, 0.25, 0.10, 0.30, [137, 142, 128, 255]);
      builder.box(0, 0.29, 0.305, 0.50, 0.055, 0.025, [205, 193, 151, 255]);
      builder.box(0, 0.12, 0.31, 0.68, 0.035, 0.025, [64, 70, 68, 255]);
    },
  }),
  coral_lime: model({
    name: "Coral Lime",
    className: "ceramic",
    shape: "porous marine lime brick",
    roughness: 1,
    description: "A chalky marine-lime brick with coral inclusions and deliberately porous faces.",
    build(builder) {
      builder.box(0, 0.27, 0, 0.80, 0.50, 0.56, [224, 210, 181, 255]);
      specks(builder, [
        [-0.24, 0.39, 0.295, [224, 125, 112, 255]],
        [0.20, 0.20, 0.295, [167, 150, 137, 255]],
        [0.03, 0.43, 0.296, [244, 234, 207, 255]],
        [0.29, 0.36, 0.296, [194, 107, 101, 255]],
      ], 0.10, 0.025);
    },
  }),
  toxic_glass: model({
    name: "Toxic Glass",
    className: "glass",
    shape: "sealed hazardous canister",
    roughness: 0.26,
    translucency: 0.34,
    emissive: [0.08, 0.22, 0.04],
    description: "A sealed green glass canister with a luminous toxic core and reinforced dark caps.",
    build(builder) {
      jar(builder, [83, 170, 92, 184], [151, 229, 86, 226], [48, 66, 55, 255]);
      builder.box(0, 0.39, 0.225, 0.22, 0.18, 0.028, [193, 236, 84, 245]);
      builder.box(0, 0.39, 0.242, 0.035, 0.13, 0.018, [61, 81, 49, 255]);
      builder.box(0, 0.39, 0.242, 0.13, 0.035, 0.018, [61, 81, 49, 255]);
    },
  }),
  cotton_cloth: model({
    name: "Cotton Cloth",
    className: "fiber",
    shape: "folded woven cotton cloth",
    roughness: 0.97,
    description: "A folded bolt of warm white cotton with a low-cost woven face pattern.",
    build(builder) {
      wovenCloth(builder, [229, 222, 202, 255], [250, 247, 233, 255], [190, 180, 157, 255]);
    },
  }),
  white_dye: model({
    name: "White Dye",
    className: "chemical",
    shape: "pressed white pigment cake",
    roughness: 0.72,
    description: "A compact white pigment cake with a pale mineral highlight and sealed base.",
    build(builder) {
      pigmentCake(builder, [235, 234, 222, 255], [255, 253, 243, 255], [171, 174, 169, 255]);
    },
  }),
  yellow_dye: model({
    name: "Yellow Dye",
    className: "chemical",
    shape: "pressed yellow pigment cake",
    roughness: 0.72,
    description: "A compact saturated yellow pigment cake with a warm mineral shadow.",
    build(builder) {
      pigmentCake(builder, [235, 185, 36, 255], [255, 226, 87, 255], [150, 104, 24, 255]);
    },
  }),
  red_dye: model({
    name: "Red Dye",
    className: "chemical",
    shape: "pressed red pigment cake",
    roughness: 0.72,
    description: "A compact saturated red pigment cake with a deep oxide shadow.",
    build(builder) {
      pigmentCake(builder, [196, 42, 46, 255], [244, 82, 72, 255], [110, 28, 35, 255]);
    },
  }),
  blue_dye: model({
    name: "Blue Dye",
    className: "chemical",
    shape: "pressed blue pigment cake",
    roughness: 0.72,
    description: "A compact saturated blue pigment cake with a cool mineral highlight.",
    build(builder) {
      pigmentCake(builder, [43, 102, 202, 255], [85, 158, 245, 255], [26, 49, 116, 255]);
    },
  }),
  pink_dye: model({
    name: "Pink Dye",
    className: "chemical",
    shape: "pressed pink pigment cake",
    roughness: 0.72,
    description: "A compact saturated pink pigment cake with a restrained berry shadow.",
    build(builder) {
      pigmentCake(builder, [224, 101, 157, 255], [255, 162, 201, 255], [140, 55, 104, 255]);
    },
  }),
  wooden_plank: model({
    name: "Wooden Plank",
    className: "wood",
    shape: "stacked sawn planks",
    roughness: 0.88,
    description: "Three offset sawn planks with readable end grain and a pale planed edge.",
    build(builder) {
      plankStack(builder, [151, 104, 61, 255], [101, 67, 42, 255], [196, 147, 88, 255]);
    },
  }),
  wooden_stick: model({
    name: "Wooden Stick",
    className: "wood",
    shape: "bound carpentry sticks",
    roughness: 0.9,
    description: "A compact crossed bundle of squared wooden sticks tied for construction use.",
    build(builder) {
      stickBundle(builder, [164, 115, 67, 255], [105, 72, 45, 255], [207, 172, 112, 255]);
    },
  }),
  squared_timber: model({
    name: "Squared Timber",
    className: "wood",
    shape: "hewn structural beam",
    roughness: 0.93,
    description: "A heavy square beam with hewn side facets and visible heartwood at the cut end.",
    build(builder) {
      timberBeam(builder, [132, 87, 50, 255], [82, 51, 33, 255], [184, 130, 73, 255]);
    },
  }),
  clear_glass_panel: model({
    name: "Clear Glass Panel",
    className: "glass",
    shape: "stacked clear glazing panels",
    roughness: 0.12,
    translucency: 0.62,
    description: "Two thin clear glazing panels with thick cooled edges and a diagonal light catch.",
    build(builder) {
      glassPanelStack(builder, [165, 226, 237, 126], [224, 249, 250, 206], [81, 163, 184, 218]);
    },
  }),
  ice_blue_glass_panel: model({
    name: "Ice-blue Glass Panel",
    className: "glass",
    shape: "frost-tinted glazing panels",
    roughness: 0.16,
    translucency: 0.54,
    description: "Cold-blue glazing with a frosted lower band and bright crystalline edge.",
    build(builder) {
      glassPanelStack(builder, [91, 174, 220, 144], [190, 237, 255, 224], [53, 112, 176, 226], [221, 250, 255, 215]);
    },
  }),
  amber_glass_panel: model({
    name: "Amber Glass Panel",
    className: "glass",
    shape: "warm amber glazing panels",
    roughness: 0.18,
    translucency: 0.47,
    description: "Warm amber glazing with a dark carbon edge and a honey-colored light streak.",
    build(builder) {
      glassPanelStack(builder, [205, 139, 48, 158], [255, 213, 119, 230], [118, 72, 35, 236], [255, 230, 145, 222]);
    },
  }),
  basalt_reinforced_glass: model({
    name: "Basalt-reinforced Glass",
    className: "composite",
    shape: "cross-ribbed safety glazing",
    roughness: 0.34,
    translucency: 0.31,
    description: "A smoke-gray laminated panel crossed by low-cost basalt-fiber safety ribs.",
    build(builder) {
      reinforcedGlassPanel(builder, [112, 145, 153, 172], [190, 220, 220, 220], [45, 55, 59, 255]);
    },
  }),
  fired_clay_brick: model({
    name: "Fired Clay Brick",
    className: "ceramic",
    shape: "kiln-fired masonry stack",
    roughness: 0.96,
    description: "Offset kiln-fired bricks with dark mortar gaps and orange chipped edges.",
    build(builder) {
      brickStack(builder, [167, 77, 48, 255], [87, 50, 40, 255], [207, 112, 68, 255]);
    },
  }),
  adobe_brick: model({
    name: "Adobe Brick",
    className: "composite",
    shape: "sun-dried fiber bricks",
    roughness: 1,
    description: "Sun-dried earth bricks with pale straw fibers visible across their rough faces.",
    build(builder) {
      brickStack(builder, [173, 119, 71, 255], [105, 76, 53, 255], [204, 153, 99, 255]);
      builder.box(0.17, 0.40, 0.224, 0.26, 0.024, 0.025, [221, 191, 116, 255], { z: -0.08 });
    },
  }),
  stone_brick: model({
    name: "Stone Brick",
    className: "stone",
    shape: "regular cut-stone stack",
    roughness: 0.9,
    description: "Regular pale-gray cut masonry with a crisp chisel line and recessed joint.",
    build(builder) {
      brickStack(builder, [139, 149, 151, 255], [83, 91, 94, 255], [181, 191, 190, 255]);
    },
  }),
  deep_stone_brick: model({
    name: "Deep-stone Brick",
    className: "stone",
    shape: "dense fortress brick stack",
    roughness: 0.92,
    description: "Dense blue-black fortress masonry with a cool mineral seam and worn edge.",
    build(builder) {
      brickStack(builder, [65, 70, 83, 255], [34, 38, 48, 255], [99, 107, 121, 255]);
    },
  }),
  basalt_brick: model({
    name: "Basalt Brick",
    className: "stone",
    shape: "heat-resistant basalt brick stack",
    roughness: 0.95,
    description: "Near-black volcanic masonry with a restrained rust-red heat fracture.",
    build(builder) {
      brickStack(builder, [47, 51, 59, 255], [24, 27, 32, 255], [78, 82, 91, 255]);
      builder.box(0.10, 0.515, 0.095, 0.25, 0.024, 0.025, [145, 67, 43, 255], { y: -0.08 });
    },
  }),
  sandstone_block: model({
    name: "Cut Sandstone Block",
    className: "stone",
    shape: "banded cut sandstone block",
    roughness: 0.98,
    description: "A cut sandstone block with stepped sediment bands and a recessed mason mark.",
    build(builder) {
      bandedBlock(builder, [215, 190, 126, 255], [177, 142, 83, 255], [239, 217, 157, 255]);
    },
  }),
  cobblestone: model({
    name: "Cobblestone",
    className: "stone",
    shape: "sorted rounded cobbles",
    roughness: 1,
    description: "A small pile of differently sized road cobbles with distinct worn top faces.",
    build(builder) {
      cobblePile(builder, [116, 120, 119, 255], [78, 83, 83, 255], [159, 160, 153, 255]);
    },
  }),
  polished_stone_slab: model({
    name: "Polished Stone Slab",
    className: "stone",
    shape: "stacked polished floor slabs",
    roughness: 0.34,
    description: "Two thin polished slabs with a mirror-bright bevel and a dark sawn underside.",
    build(builder) {
      polishedSlabStack(builder, [164, 176, 179, 255], [98, 108, 112, 255], [224, 232, 231, 255]);
    },
  }),
  lime_plaster: model({
    name: "Lime Plaster",
    className: "composite",
    shape: "lime plaster tray and trowel",
    roughness: 0.92,
    description: "A shallow tray of pale lime plaster with a clean trowel groove across the surface.",
    build(builder) {
      plasterTray(builder, [219, 211, 185, 255], [153, 141, 116, 255], [244, 239, 218, 255]);
    },
  }),
  clay_plaster: model({
    name: "Clay Plaster",
    className: "composite",
    shape: "earthen plaster tray and trowel",
    roughness: 0.98,
    description: "A shallow tray of warm clay render with a straw fleck and a broad trowel groove.",
    build(builder) {
      plasterTray(builder, [181, 126, 91, 255], [116, 78, 57, 255], [218, 166, 123, 255], [219, 191, 109, 255]);
    },
  }),
  rammed_earth: model({
    name: "Rammed Earth",
    className: "composite",
    shape: "layered compacted-earth sample",
    roughness: 1,
    description: "A monolithic wall sample with alternating compacted earth lifts and gravel inclusions.",
    build(builder) {
      rammedEarthSample(builder, [137, 87, 52, 255], [169, 111, 67, 255], [96, 67, 49, 255]);
    },
  }),
  shell_terrazzo: model({
    name: "Shell Terrazzo Slab",
    className: "composite",
    shape: "shell-flecked terrazzo slab",
    roughness: 0.38,
    description: "A polished coastal slab with embedded shell, coral, and dark stone chips.",
    build(builder) {
      terrazzoSlab(builder, [205, 193, 164, 255], [126, 120, 109, 255], [244, 235, 207, 255]);
    },
  }),
  white_ceramic_tile: model({
    name: "White Ceramic Tile",
    className: "ceramic",
    shape: "stacked glazed finish tiles",
    roughness: 0.22,
    description: "Thin white glazed tiles with a warm ceramic core and bright kiln-fired face.",
    build(builder) {
      finishTileStack(builder, [220, 219, 207, 255], [164, 145, 119, 255], [252, 250, 234, 255]);
    },
  }),
  blue_ceramic_tile: model({
    name: "Blue Ceramic Tile",
    className: "ceramic",
    shape: "stacked blue glazed tiles",
    roughness: 0.18,
    description: "Blue glazed finish tiles with a pale clay edge and a crisp water-blue highlight.",
    build(builder) {
      finishTileStack(builder, [69, 132, 186, 255], [171, 153, 125, 255], [125, 195, 231, 255]);
    },
  }),
  volcanic_ash_concrete: model({
    name: "Volcanic-ash Concrete",
    className: "composite",
    shape: "reinforced aggregate sample",
    roughness: 0.96,
    description: "A dense structural concrete sample with basalt aggregate and exposed reinforcement ends.",
    build(builder) {
      concreteSample(builder, [96, 99, 103, 255], [57, 61, 66, 255], [142, 139, 132, 255]);
    },
  }),
  salt_crystal_block: model({
    name: "Salt Crystal Block",
    className: "crystal",
    shape: "cut translucent salt masonry",
    roughness: 0.32,
    translucency: 0.28,
    description: "A cut salt block with translucent stepped crystals rising from one corner.",
    build(builder) {
      saltCrystalBlock(builder, [221, 217, 195, 220], [250, 246, 222, 242], [161, 157, 143, 245]);
    },
  }),
  roof_tile_terracotta: model({
    name: "Terracotta Roof Tile",
    className: "ceramic",
    shape: "stacked overlapping roof tiles",
    roughness: 0.9,
    description: "Overlapping terracotta roof tiles with stepped curved ridges and fired-orange edges.",
    build(builder) {
      roofTileStack(builder, [146, 69, 40, 255], [92, 48, 34, 255], [197, 107, 61, 255]);
    },
  }),
  roof_tile_ice_blue: model({
    name: "Ice-blue Glazed Roof Tile",
    className: "ceramic",
    shape: "ice-blue glazed roof-tile stack",
    roughness: 0.2,
    description: "Overlapping blue-glazed tiles with icy highlights along their raised ridges.",
    build(builder) {
      roofTileStack(builder, [68, 132, 199, 255], [43, 78, 130, 255], [133, 203, 248, 255]);
    },
  }),
  roof_tile_shell_white: model({
    name: "Shell-white Glazed Roof Tile",
    className: "ceramic",
    shape: "shell-white glazed roof-tile stack",
    roughness: 0.24,
    description: "Cream-white glazed tiles with warm shell edges and a pearl face highlight.",
    build(builder) {
      roofTileStack(builder, [211, 205, 184, 255], [155, 143, 122, 255], [255, 247, 218, 255]);
    },
  }),
  roof_tile_charcoal: model({
    name: "Charcoal-black Glazed Roof Tile",
    className: "ceramic",
    shape: "charcoal glazed roof-tile stack",
    roughness: 0.28,
    description: "Black glazed tiles with graphite ridge reflections and a warm fired-clay underside.",
    build(builder) {
      roofTileStack(builder, [38, 42, 49, 255], [22, 25, 30, 255], [90, 97, 109, 255], [126, 67, 43, 255]);
    },
  }),
  roof_tile_ash_gray: model({
    name: "Volcanic-ash Glazed Roof Tile",
    className: "ceramic",
    shape: "ash-gray glazed roof-tile stack",
    roughness: 0.32,
    description: "Gray glazed tiles with mottled volcanic aggregate and a cool silver ridge.",
    build(builder) {
      roofTileStack(builder, [105, 108, 113, 255], [61, 64, 70, 255], [166, 165, 159, 255]);
    },
  }),
  roof_tile_mycelium: model({
    name: "Mycelium-glow Glazed Roof Tile",
    className: "ceramic",
    shape: "luminous teal roof-tile stack",
    roughness: 0.25,
    emissive: [0.03, 0.16, 0.12],
    description: "Teal glazed tiles with a restrained mycelium glow running along their raised seams.",
    build(builder) {
      roofTileStack(builder, [59, 155, 132, 255], [32, 92, 82, 255], [139, 239, 207, 255]);
    },
  }),
  blasting_charge: model({
    name: "Blasting Charge",
    className: "chemical",
    shape: "bound mining-charge bundle with a raised fuse",
    roughness: 0.86,
    description: "Three compact resin-bound charge columns, two retaining bands, and a readable raised fuse.",
    build(builder) {
      const casing = [151, 74, 50, 255];
      const casingDark = [104, 47, 36, 255];
      const band = [48, 43, 39, 255];
      const fuse = [202, 164, 83, 255];
      builder.box(-0.20, 0.34, 0, 0.18, 0.64, 0.24, casingDark, { z: -0.025 });
      builder.box(0, 0.35, 0.01, 0.19, 0.66, 0.25, casing, { z: 0.018 });
      builder.box(0.20, 0.34, 0, 0.18, 0.64, 0.24, [176, 88, 54, 255], { z: 0.035 });
      builder.box(0, 0.22, 0.005, 0.64, 0.075, 0.29, band, { z: -0.015 });
      builder.box(0, 0.50, 0.005, 0.64, 0.075, 0.29, [68, 58, 49, 255], { z: 0.015 });
      builder.box(0.20, 0.71, 0, 0.11, 0.13, 0.12, band, { z: 0.08 });
      builder.box(0.27, 0.84, 0, 0.065, 0.22, 0.065, fuse, { z: -0.38 });
    },
  }),
});

export const SMELTING_MATERIAL_MODEL_IDS = Object.freeze(Object.keys(MODEL_DEFS));

export function hasSmeltingMaterialPreviewModel(materialId) {
  return Boolean(MODEL_DEFS[normalizeMaterialId(materialId)]);
}

export function smeltingMaterialModelDefinition(materialId) {
  return MODEL_DEFS[normalizeMaterialId(materialId)] ?? null;
}

/**
 * Returns the canonical palette and finish shared by material icons and
 * forged surfaces. Colors are collected from the existing model builder so
 * the renderer does not maintain a second material palette or build geometry.
 */
export function smeltingMaterialSurfaceProfile(materialId) {
  const normalizedMaterialId = normalizeMaterialId(materialId);
  const definition = MODEL_DEFS[normalizedMaterialId];
  if (!definition) return null;
  const cached = surfaceProfileCache.get(normalizedMaterialId);
  if (cached) return cached;

  const palette = collectDefinitionPalette(definition);
  const emissive = Object.freeze(normalizeEmissive(definition.emissive));
  const finish = Object.freeze({
    roughness: normalizeUnit(definition.roughness, 0.8),
    translucency: normalizeUnit(definition.translucency, 0),
    emissive,
  });
  const cacheSignature = JSON.stringify([
    SMELTING_MATERIAL_VISUAL_REVISION,
    normalizedMaterialId,
    definition.className,
    palette,
    finish.roughness,
    finish.translucency,
    finish.emissive,
  ]);
  const profile = Object.freeze({
    materialId: normalizedMaterialId,
    className: definition.className,
    visualRevision: SMELTING_MATERIAL_VISUAL_REVISION,
    cacheSignature,
    palette,
    baseColor: palette[0],
    finish,
  });
  surfaceProfileCache.set(normalizedMaterialId, profile);
  if (surfaceProfileCache.size > MODEL_CACHE_LIMIT) {
    surfaceProfileCache.delete(surfaceProfileCache.keys().next().value);
  }
  return profile;
}

export function createSmeltingMaterialPreviewMesh(options = {}) {
  const materialId = normalizeMaterialId(options.materialId ?? options.id);
  const definition = MODEL_DEFS[materialId];
  if (!definition) return emptyMesh(materialId);
  const cached = modelCache.get(materialId);
  if (cached) return cached;
  const vertices = [];
  const indices = [];
  definition.build(createBuilder(vertices, indices));
  const colors = uniqueColors(vertices);
  const mesh = {
    id: `smelting_material_${materialId}`,
    materialId,
    name: definition.name,
    category: "smelting material",
    className: definition.className,
    shape: definition.shape,
    description: definition.description,
    roughness: definition.roughness,
    translucency: definition.translucency,
    emissive: definition.emissive,
    vertexFormat: "chunk-object",
    vertices,
    indices,
    layers: [],
    colors,
    quadCount: indices.length / 6,
    triangleCount: indices.length / 3,
    vertexCount: vertices.length,
    collision: false,
  };
  modelCache.set(materialId, mesh);
  if (modelCache.size > MODEL_CACHE_LIMIT) modelCache.delete(modelCache.keys().next().value);
  return mesh;
}

function model({
  name,
  className,
  shape,
  description,
  roughness = 0.8,
  translucency = 0,
  emissive = [0, 0, 0],
  build,
}) {
  return Object.freeze({ name, className, shape, description, roughness, translucency, emissive, build });
}

function createBuilder(vertices, indices) {
  return Object.freeze({
    box(cx, cy, cz, sx, sy, sz, color, rotation = {}) {
      appendBox(vertices, indices, { cx, cy, cz, sx, sy, sz, color, rotation });
    },
  });
}

function collectDefinitionPalette(definition) {
  const colors = new Map();
  definition.build(Object.freeze({
    box(...args) {
      const color = normalizeColor(args[6]);
      colors.set(color.join(","), color);
    },
  }));
  return Object.freeze([...colors.values()].map((color) => Object.freeze(color)));
}

function appendBox(vertices, indices, part) {
  const x0 = -part.sx * 0.5;
  const x1 = part.sx * 0.5;
  const y0 = -part.sy * 0.5;
  const y1 = part.sy * 0.5;
  const z0 = -part.sz * 0.5;
  const z1 = part.sz * 0.5;
  const faces = [
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
    { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
    { n: [0, 1, 0], p: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [0, -1, 0], p: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]] },
    { n: [0, 0, 1], p: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
    { n: [0, 0, -1], p: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]] },
  ];
  const color = normalizeColor(part.color);
  for (const face of faces) {
    const offset = vertices.length;
    for (let index = 0; index < 4; index += 1) {
      const local = rotateVector(face.p[index], part.rotation);
      const normal = rotateVector(face.n, part.rotation);
      vertices.push({
        p: [local[0] + part.cx, local[1] + part.cy, local[2] + part.cz],
        n: normal.map((value) => Math.round(value * 127)),
        uv: index === 0 ? [0, 0] : index === 1 ? [0, 1] : index === 2 ? [1, 1] : [1, 0],
        layer: null,
        ao: 255,
        flags: 0,
        color,
      });
    }
    indices.push(offset, offset + 2, offset + 1, offset, offset + 3, offset + 2);
  }
}

function rotateVector(point, rotation = {}) {
  const rx = Number(rotation.x) || 0;
  const ry = Number(rotation.y) || 0;
  const rz = Number(rotation.z) || 0;
  let [x, y, z] = point;
  if (rx) [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  if (ry) [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  if (rz) [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x, y, z];
}

function rubble(builder, base, shadow, options = {}) {
  const accent = options.accent ?? tint(base, 34);
  builder.box(-0.19, 0.16, 0.06, 0.36, 0.26, 0.30, base, { y: 0.18, z: -0.12 });
  builder.box(0.18, 0.14, -0.07, 0.34, 0.22, 0.28, shadow, { y: -0.22, z: 0.16 });
  builder.box(0.02, 0.34, 0.01, 0.30, 0.25, 0.27, accent, { y: 0.10, z: 0.08 });
  builder.box(-0.27, 0.29, 0.20, 0.13, 0.10, 0.08, tint(base, 18), { z: -0.28 });
  if (options.ember) builder.box(0.02, 0.32, 0.153, 0.19, 0.035, 0.025, options.ember, { z: 0.06 });
}

function jar(builder, shell, core, cap) {
  builder.box(0, 0.31, 0, 0.52, 0.54, 0.40, shell);
  builder.box(0, 0.31, 0.02, 0.34, 0.39, 0.30, core);
  builder.box(0, 0.61, 0, 0.34, 0.10, 0.30, tint(shell, 18));
  builder.box(0, 0.73, 0, 0.27, 0.16, 0.25, cap);
  builder.box(0, 0.82, 0, 0.34, 0.055, 0.30, tint(cap, -18));
  builder.box(-0.19, 0.38, 0.215, 0.035, 0.31, 0.025, [236, 248, 226, 170]);
}

function brickStack(builder, base, seam, highlight) {
  builder.box(-0.17, 0.14, 0.03, 0.55, 0.22, 0.42, base, { y: 0.06 });
  builder.box(0.22, 0.14, -0.04, 0.26, 0.22, 0.40, tint(base, -14), { y: 0.06 });
  builder.box(0.12, 0.39, 0, 0.60, 0.22, 0.42, highlight, { y: -0.08 });
  builder.box(-0.20, 0.39, 0, 0.05, 0.23, 0.43, seam, { y: -0.08 });
  builder.box(0.12, 0.515, 0.08, 0.38, 0.025, 0.22, tint(highlight, 25), { y: -0.08 });
}

function tileStack(builder, base, core, highlight) {
  builder.box(-0.05, 0.13, 0.02, 0.72, 0.16, 0.52, core, { y: 0.09 });
  builder.box(0.04, 0.30, 0, 0.72, 0.14, 0.52, base, { y: -0.05 });
  builder.box(-0.02, 0.46, 0.01, 0.72, 0.13, 0.52, highlight, { y: 0.04 });
  builder.box(-0.02, 0.535, 0.05, 0.48, 0.025, 0.28, [255, 249, 224, 255], { y: 0.04 });
}

function crystalCluster(builder, base, highlight, foot) {
  builder.box(0, 0.08, 0, 0.74, 0.16, 0.52, foot);
  const shards = [
    [-0.20, 0.34, 0.06, 0.18, 0.54, -0.13],
    [0.02, 0.45, -0.02, 0.20, 0.76, 0.04],
    [0.23, 0.30, 0.08, 0.16, 0.45, 0.18],
    [0.13, 0.25, -0.14, 0.13, 0.37, -0.18],
  ];
  for (let index = 0; index < shards.length; index += 1) {
    const [x, y, z, sx, sy, lean] = shards[index];
    builder.box(x, y, z, sx, sy, sx, index % 2 ? highlight : base, { z: lean, y: lean * 0.5 });
    builder.box(x - Math.sin(lean) * sy * 0.46, y + sy * 0.42, z, sx * 0.62, sy * 0.18, sx * 0.62, tint(highlight, 18), { z: lean, y: lean * 0.5 });
  }
}

function glassIngot(builder, shell, highlight, edge) {
  builder.box(0, 0.20, 0, 0.78, 0.34, 0.48, shell, { y: -0.05 });
  builder.box(0, 0.39, -0.01, 0.58, 0.10, 0.34, highlight, { y: -0.05 });
  builder.box(-0.29, 0.29, 0.23, 0.055, 0.24, 0.025, edge, { y: -0.05 });
  builder.box(0.08, 0.43, 0.18, 0.30, 0.025, 0.025, [242, 255, 255, 218], { y: -0.05 });
}

function circuitTrace(builder, metal) {
  const y = 0.174;
  builder.box(-0.18, y, 0.12, 0.27, 0.022, 0.035, metal);
  builder.box(-0.04, y, 0.02, 0.035, 0.022, 0.22, metal);
  builder.box(0.16, y, -0.10, 0.31, 0.022, 0.035, metal);
  builder.box(0.28, y, 0.12, 0.08, 0.026, 0.08, tint(metal, 24));
  builder.box(-0.30, y, -0.15, 0.08, 0.026, 0.08, tint(metal, 24));
}

function metalBloom(builder, base, highlight, trace) {
  const nodes = [
    [-0.24, 0.17, 0.03, 0.34, 0.26, 0.32], [0.12, 0.17, -0.08, 0.40, 0.30, 0.34],
    [0.30, 0.23, 0.12, 0.25, 0.29, 0.27], [-0.04, 0.39, 0.05, 0.35, 0.25, 0.31],
  ];
  for (let index = 0; index < nodes.length; index += 1) {
    const [x, y, z, sx, sy, sz] = nodes[index];
    builder.box(x, y, z, sx, sy, sz, index === 3 ? highlight : tint(base, index * 5), { y: x * 0.35, z: z * 0.5 });
  }
  builder.box(0.06, 0.30, 0.235, 0.25, 0.055, 0.025, trace, { z: 0.08 });
  builder.box(-0.28, 0.27, 0.205, 0.10, 0.065, 0.025, tint(highlight, 16));
}

function technicalPlate(builder, base, edge, accent) {
  builder.box(0, 0.12, 0, 0.80, 0.16, 0.62, edge);
  builder.box(0, 0.225, 0, 0.68, 0.09, 0.50, base);
  builder.box(0, 0.285, 0.10, 0.42, 0.035, 0.20, accent);
  const pads = [[-0.30, -0.21], [0.30, -0.21], [-0.30, 0.21], [0.30, 0.21]];
  for (const [x, z] of pads) builder.box(x, 0.30, z, 0.075, 0.055, 0.075, tint(accent, 18));
}

function alloyBar(builder, base, highlight, band) {
  builder.box(0, 0.22, 0, 0.82, 0.34, 0.42, base, { y: 0.04 });
  builder.box(0, 0.415, -0.01, 0.62, 0.08, 0.28, highlight, { y: 0.04 });
  builder.box(-0.31, 0.23, 0, 0.11, 0.37, 0.44, band, { y: 0.04 });
  builder.box(0.31, 0.23, 0, 0.11, 0.37, 0.44, band, { y: 0.04 });
  builder.box(0.04, 0.45, 0.12, 0.30, 0.025, 0.025, [238, 244, 242, 215], { y: 0.04 });
}

function layeredPlate(builder, base, middle, weave) {
  builder.box(-0.04, 0.11, 0.03, 0.76, 0.10, 0.56, base, { y: 0.07 });
  builder.box(0.03, 0.23, -0.01, 0.76, 0.09, 0.56, middle, { y: -0.05 });
  builder.box(-0.02, 0.34, 0.02, 0.76, 0.08, 0.56, base, { y: 0.03 });
  for (let index = -2; index <= 2; index += 1) {
    builder.box(index * 0.13, 0.39, 0.13, 0.025, 0.025, 0.34, weave, { z: 0.55 });
  }
}

function fiberSpool(builder, fiber, rim, heat) {
  builder.box(0, 0.31, 0, 0.72, 0.20, 0.20, fiber, { y: Math.PI * 0.5 });
  builder.box(-0.35, 0.31, 0, 0.10, 0.52, 0.52, rim);
  builder.box(0.35, 0.31, 0, 0.10, 0.52, 0.52, rim);
  builder.box(0, 0.31, 0.11, 0.56, 0.045, 0.035, tint(fiber, 28), { z: 0.08 });
  builder.box(0, 0.12, 0.18, 0.48, 0.035, 0.035, heat, { z: -0.04 });
  builder.box(0, 0.50, -0.18, 0.48, 0.035, 0.035, tint(heat, -25), { z: 0.04 });
}

function wovenCloth(builder, fiber, highlight, shadow) {
  builder.box(0.03, 0.24, -0.01, 0.76, 0.10, 0.54, fiber, { y: -0.03 });
  builder.box(-0.04, 0.12, 0.02, 0.78, 0.11, 0.56, shadow, { y: 0.04 });
  builder.box(-0.01, 0.35, 0.02, 0.74, 0.09, 0.52, highlight, { y: 0.02 });
  for (let index = -1; index <= 1; index += 1) {
    builder.box(index * 0.18, 0.405, 0.06, 0.022, 0.022, 0.40, tint(fiber, index * 5), { z: 0.04 });
  }
  builder.box(-0.02, 0.408, -0.08, 0.58, 0.018, 0.022, shadow, { y: 0.02 });
  builder.box(0.02, 0.408, 0.11, 0.58, 0.018, 0.022, fiber, { y: 0.02 });
}

function pigmentCake(builder, pigment, highlight, shadow) {
  builder.box(0, 0.19, 0, 0.58, 0.12, 0.42, pigment);
  builder.box(0, 0.07, 0, 0.66, 0.14, 0.48, shadow);
  builder.box(-0.14, 0.285, 0.05, 0.24, 0.07, 0.24, highlight, { y: 0.08 });
  builder.box(0.14, 0.28, -0.04, 0.23, 0.065, 0.22, tint(pigment, -12), { y: -0.10 });
  builder.box(0.02, 0.325, 0.12, 0.30, 0.025, 0.025, tint(highlight, 10), { z: 0.06 });
}

function plankStack(builder, wood, endGrain, highlight) {
  builder.box(-0.03, 0.10, 0.06, 0.86, 0.12, 0.24, endGrain, { y: 0.05 });
  builder.box(0.02, 0.23, -0.03, 0.86, 0.12, 0.24, wood, { y: -0.04 });
  builder.box(-0.04, 0.36, 0.04, 0.86, 0.12, 0.24, highlight, { y: 0.03 });
  builder.box(0.395, 0.36, 0.04, 0.035, 0.095, 0.19, endGrain, { y: 0.03 });
  builder.box(-0.09, 0.425, 0.145, 0.48, 0.018, 0.018, tint(highlight, 25), { y: 0.03 });
}

function stickBundle(builder, wood, shadow, tie) {
  builder.box(-0.10, 0.23, 0.02, 0.72, 0.11, 0.11, wood, { y: 0.17, z: 0.12 });
  builder.box(0.09, 0.25, -0.04, 0.74, 0.10, 0.10, tint(wood, 16), { y: -0.13, z: -0.08 });
  builder.box(0, 0.38, 0.03, 0.68, 0.10, 0.10, shadow, { y: 0.04, z: 0.07 });
  builder.box(-0.10, 0.27, 0.02, 0.08, 0.34, 0.17, tie, { y: 0.17, z: 0.12 });
  builder.box(0.13, 0.30, 0, 0.075, 0.34, 0.17, tint(tie, -25), { y: -0.13, z: -0.08 });
}

function timberBeam(builder, wood, heartwood, highlight) {
  builder.box(0, 0.27, 0, 0.82, 0.34, 0.34, wood, { y: -0.08 });
  builder.box(0.39, 0.27, 0.055, 0.035, 0.27, 0.23, heartwood, { y: -0.08 });
  builder.box(0.41, 0.27, 0.055, 0.018, 0.12, 0.10, highlight, { y: -0.08 });
  builder.box(-0.05, 0.455, 0.08, 0.58, 0.025, 0.07, highlight, { y: -0.08 });
  builder.box(-0.37, 0.20, -0.11, 0.035, 0.18, 0.08, tint(heartwood, -18), { y: -0.08 });
}

function glassPanelStack(builder, glass, highlight, edge, frost = null) {
  builder.box(-0.03, 0.27, 0.02, 0.72, 0.48, 0.055, glass, { y: 0.08 });
  builder.box(0.08, 0.31, -0.08, 0.70, 0.46, 0.05, tint(glass, -12), { y: -0.07 });
  builder.box(-0.34, 0.27, 0.045, 0.035, 0.42, 0.075, edge, { y: 0.08 });
  builder.box(0.04, 0.36, 0.055, 0.035, 0.32, 0.018, highlight, { z: -0.56, y: 0.08 });
  builder.box(0.18, 0.49, 0.06, 0.24, 0.025, 0.018, frost ?? highlight, { y: 0.08 });
}

function reinforcedGlassPanel(builder, glass, highlight, rib) {
  builder.box(0, 0.30, 0, 0.76, 0.50, 0.075, glass, { y: 0.04 });
  builder.box(0, 0.30, 0.045, 0.66, 0.035, 0.045, rib, { z: 0.65, y: 0.04 });
  builder.box(0, 0.30, 0.046, 0.66, 0.035, 0.045, rib, { z: -0.65, y: 0.04 });
  builder.box(-0.36, 0.30, 0, 0.035, 0.47, 0.09, tint(rib, 24), { y: 0.04 });
  builder.box(0.36, 0.30, 0, 0.035, 0.47, 0.09, tint(rib, -12), { y: 0.04 });
  builder.box(-0.18, 0.46, 0.052, 0.16, 0.025, 0.018, highlight, { y: 0.04 });
}

function bandedBlock(builder, base, shadow, highlight) {
  builder.box(0, 0.27, 0, 0.80, 0.50, 0.56, base);
  builder.box(0, 0.16, 0.291, 0.72, 0.065, 0.024, shadow);
  builder.box(0, 0.34, 0.292, 0.72, 0.045, 0.024, tint(base, -13));
  builder.box(0, 0.47, 0.292, 0.72, 0.035, 0.024, highlight);
  builder.box(0.25, 0.28, 0.307, 0.13, 0.13, 0.018, tint(shadow, 18));
}

function cobblePile(builder, base, shadow, highlight) {
  builder.box(-0.22, 0.16, 0.10, 0.36, 0.26, 0.32, base, { y: 0.12, z: -0.08 });
  builder.box(0.20, 0.14, 0.08, 0.34, 0.22, 0.30, shadow, { y: -0.17, z: 0.10 });
  builder.box(-0.04, 0.17, -0.18, 0.38, 0.25, 0.28, tint(base, 14), { y: 0.21, z: 0.06 });
  builder.box(0.05, 0.37, 0.02, 0.34, 0.27, 0.31, highlight, { y: -0.11, z: -0.06 });
  builder.box(0.28, 0.32, -0.13, 0.22, 0.18, 0.20, tint(shadow, 24), { y: 0.14 });
}

function polishedSlabStack(builder, slab, underside, highlight) {
  builder.box(-0.02, 0.11, 0.04, 0.82, 0.12, 0.58, underside, { y: 0.06 });
  builder.box(0.05, 0.24, -0.03, 0.80, 0.11, 0.58, slab, { y: -0.05 });
  builder.box(0.05, 0.305, -0.03, 0.69, 0.018, 0.47, highlight, { y: -0.05 });
  builder.box(-0.26, 0.316, 0.12, 0.22, 0.012, 0.025, tint(highlight, 20), { y: -0.05 });
  builder.box(0.42, 0.24, -0.03, 0.025, 0.08, 0.45, tint(slab, -28), { y: -0.05 });
}

function plasterTray(builder, plaster, tray, highlight, fleck = null) {
  builder.box(0, 0.10, 0, 0.78, 0.12, 0.58, tray);
  builder.box(0, 0.18, 0, 0.68, 0.08, 0.48, plaster);
  builder.box(-0.12, 0.235, 0.02, 0.45, 0.025, 0.09, highlight, { y: 0.09, z: -0.10 });
  builder.box(0.19, 0.30, 0.04, 0.32, 0.035, 0.12, tint(tray, 36), { y: -0.16, z: 0.18 });
  builder.box(0.32, 0.40, -0.04, 0.26, 0.05, 0.07, tint(tray, -16), { y: -0.16, z: 0.18 });
  if (fleck) builder.box(-0.22, 0.235, 0.15, 0.15, 0.018, 0.018, fleck, { y: 0.18 });
}

function rammedEarthSample(builder, dark, middle, light) {
  builder.box(0, 0.12, 0, 0.78, 0.16, 0.54, dark);
  builder.box(0, 0.25, 0, 0.78, 0.10, 0.54, middle);
  builder.box(0, 0.37, 0, 0.78, 0.11, 0.54, light);
  builder.box(0, 0.49, 0, 0.78, 0.10, 0.54, tint(middle, -8));
  builder.box(-0.22, 0.38, 0.282, 0.12, 0.045, 0.025, [91, 86, 78, 255], { z: 0.13 });
  builder.box(0.25, 0.20, 0.282, 0.09, 0.06, 0.025, [183, 162, 119, 255], { z: -0.09 });
}

function terrazzoSlab(builder, slab, edge, shell) {
  builder.box(0, 0.13, 0, 0.80, 0.16, 0.58, edge, { y: 0.04 });
  builder.box(0, 0.225, 0, 0.75, 0.035, 0.53, slab, { y: 0.04 });
  specks(builder, [
    [-0.25, 0.25, 0.10, shell],
    [0.20, 0.25, -0.12, [184, 118, 104, 255]],
    [0.02, 0.25, 0.17, [87, 91, 91, 255]],
    [0.29, 0.25, 0.07, tint(shell, -25)],
  ], 0.08, 0.035);
}

function finishTileStack(builder, glaze, core, highlight) {
  builder.box(-0.04, 0.10, 0.04, 0.70, 0.08, 0.52, core, { y: 0.08 });
  builder.box(0.04, 0.19, -0.02, 0.70, 0.08, 0.52, tint(glaze, -10), { y: -0.05 });
  builder.box(-0.01, 0.28, 0.02, 0.70, 0.075, 0.52, glaze, { y: 0.03 });
  builder.box(-0.01, 0.325, 0.02, 0.61, 0.018, 0.43, highlight, { y: 0.03 });
  builder.box(-0.22, 0.338, 0.11, 0.18, 0.012, 0.018, tint(highlight, 18), { y: 0.03 });
}

function concreteSample(builder, concrete, shadow, aggregate) {
  builder.box(0, 0.27, 0, 0.78, 0.50, 0.56, concrete);
  builder.box(-0.25, 0.40, 0.292, 0.10, 0.07, 0.025, aggregate, { z: 0.10 });
  builder.box(0.18, 0.20, 0.292, 0.08, 0.09, 0.025, tint(aggregate, -24), { z: -0.12 });
  builder.box(0.06, 0.47, 0.292, 0.12, 0.045, 0.025, tint(concrete, 35), { z: 0.18 });
  builder.box(-0.40, 0.18, -0.16, 0.07, 0.07, 0.13, shadow, { x: 0.16 });
  builder.box(-0.40, 0.36, 0.15, 0.07, 0.07, 0.13, tint(shadow, 28), { x: -0.14 });
}

function saltCrystalBlock(builder, salt, highlight, edge) {
  builder.box(0, 0.23, 0, 0.72, 0.42, 0.54, salt);
  builder.box(-0.34, 0.23, 0.03, 0.035, 0.34, 0.44, edge);
  builder.box(0.22, 0.50, 0.10, 0.15, 0.32, 0.15, highlight, { z: 0.24 });
  builder.box(0.04, 0.46, 0.17, 0.13, 0.24, 0.13, tint(salt, 24), { z: -0.17 });
  builder.box(-0.14, 0.42, 0.13, 0.11, 0.18, 0.11, tint(highlight, -14), { z: 0.11 });
}

function roofTileStack(builder, glaze, shadow, highlight, underside = null) {
  const core = underside ?? shadow;
  builder.box(-0.06, 0.11, 0.06, 0.70, 0.08, 0.40, core, { y: 0.08, z: -0.08 });
  builder.box(0.02, 0.19, -0.01, 0.70, 0.075, 0.40, tint(glaze, -12), { y: -0.04, z: 0.05 });
  builder.box(-0.02, 0.27, 0.04, 0.70, 0.07, 0.40, glaze, { y: 0.04, z: -0.04 });
  builder.box(-0.22, 0.325, 0.04, 0.12, 0.07, 0.38, highlight, { y: 0.04 });
  builder.box(0.02, 0.325, 0.04, 0.12, 0.07, 0.38, tint(highlight, -12), { y: 0.04 });
  builder.box(0.26, 0.325, 0.04, 0.12, 0.07, 0.38, highlight, { y: 0.04 });
}

function specks(builder, entries, defaultSize = 0.09, depth = 0.05) {
  for (const [x, y, z, color, size = defaultSize] of entries) builder.box(x, y, z, size, size, depth, color);
}

function uniqueColors(vertices) {
  const map = new Map();
  for (const vertex of vertices) {
    const color = normalizeColor(vertex.color);
    map.set(color.join(","), color);
  }
  return [...map.values()];
}

function normalizeColor(color) {
  const source = Array.isArray(color) ? color : [150, 160, 170, 255];
  return [0, 1, 2, 3].map((index) => Math.max(0, Math.min(255, Math.round(Number(source[index] ?? (index === 3 ? 255 : 0))))));
}

function normalizeEmissive(emissive) {
  const source = Array.isArray(emissive) ? emissive : [0, 0, 0];
  return [0, 1, 2].map((index) => normalizeUnit(source[index], 0));
}

function normalizeUnit(value, fallback) {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : fallback));
}

function tint(color, amount) {
  const source = normalizeColor(color);
  return [
    Math.max(0, Math.min(255, source[0] + amount)),
    Math.max(0, Math.min(255, source[1] + amount)),
    Math.max(0, Math.min(255, source[2] + amount)),
    source[3],
  ];
}

function normalizeMaterialId(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

function emptyMesh(materialId) {
  return {
    id: `smelting_material_unknown_${materialId || "material"}`,
    materialId,
    name: "Unknown Material",
    category: "smelting material",
    className: "material",
    shape: "unregistered",
    description: "No smelting material model is registered for this identifier.",
    roughness: 1,
    translucency: 0,
    emissive: [0, 0, 0],
    vertexFormat: "chunk-object",
    vertices: [],
    indices: [],
    layers: [],
    colors: [],
    quadCount: 0,
    triangleCount: 0,
    vertexCount: 0,
    collision: false,
  };
}
