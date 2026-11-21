// Jeux de surfaces. Chaque surface a :
//  - mask  : couleur dans le masque exporté (doit être unique dans le jeu)
//  - sat   : couleur d'affichage / image satellite
//  - role  : usage pour la peinture automatique (herbe, sable, roche...)
//  - rvmat : matériau écrit dans layers.cfg (vide = à remplir par ton mod)

const GENERIC = [
  { id: 'grass',    name: 'Herbe',         role: 'grass',    mask: [0, 255, 0],     sat: [92, 118, 58] },
  { id: 'grassdry', name: 'Herbe sèche',   role: 'drygrass', mask: [255, 255, 0],   sat: [150, 140, 85] },
  { id: 'forest',   name: 'Sol forestier', role: 'forest',   mask: [0, 128, 0],     sat: [62, 74, 40] },
  { id: 'dirt',     name: 'Terre',         role: 'dirt',     mask: [128, 64, 0],    sat: [118, 96, 70] },
  { id: 'sand',     name: 'Sable',         role: 'sand',     mask: [255, 200, 128], sat: [196, 180, 140] },
  { id: 'rock',     name: 'Roche',         role: 'rock',     mask: [128, 128, 128], sat: [120, 116, 110] },
  { id: 'gravel',   name: 'Gravier',       role: 'gravel',   mask: [200, 200, 200], sat: [150, 146, 136] },
  { id: 'concrete', name: 'Béton',         role: 'concrete', mask: [0, 0, 255],     sat: [140, 140, 140] },
];

// Surfaces vanilla d'Arma 3 (dossier a3\map_data, utilisées par Altis et Stratis).
const A3 = (id, name, role, mask, sat) => ({
  id, name, role, mask, sat,
  rvmat: `a3\\map_data\\${id}.rvmat`,
});
const ALTIS = [
  A3('gdt_grass_green', 'Herbe verte',     'grass',    [0, 255, 0],     [92, 118, 58]),
  A3('gdt_dry_grass',   'Herbe sèche',     'drygrass', [255, 255, 0],   [150, 140, 85]),
  A3('gdt_wild_grass',  'Herbe sauvage',   '',         [128, 255, 0],   [110, 126, 64]),
  A3('gdt_forest_pine', 'Forêt de pins',   'forest',   [0, 128, 0],     [62, 74, 40]),
  A3('gdt_thorn',       'Broussailles',    '',         [128, 128, 0],   [104, 100, 60]),
  A3('gdt_dirt',        'Terre',           'dirt',     [128, 64, 0],    [118, 96, 70]),
  A3('gdt_soil',        'Sol nu',          '',         [160, 96, 32],   [132, 110, 80]),
  A3('gdt_mud',         'Boue',            '',         [96, 48, 0],     [92, 76, 56]),
  A3('gdt_marsh',       'Marais',          '',         [0, 128, 128],   [78, 92, 62]),
  A3('gdt_beach',       'Plage',           'sand',     [255, 200, 128], [196, 180, 140]),
  A3('gdt_desert',      'Désert',          '',         [255, 128, 0],   [186, 160, 112]),
  A3('gdt_rock',        'Roche',           'rock',     [128, 128, 128], [120, 116, 110]),
  A3('gdt_stony',       'Pierraille',      'gravel',   [200, 200, 200], [150, 146, 136]),
  A3('gdt_concrete',    'Béton',           'concrete', [0, 0, 255],     [140, 140, 140]),
  A3('gdt_seabed',      'Fond marin',      'seabed',   [0, 255, 255],   [120, 130, 110]),
];

export const SURFACE_SETS = {
  altis: { name: 'Altis / Stratis', note: 'Surfaces vanilla (a3\\map_data)', surfaces: ALTIS },
  generic: { name: 'Générique', note: 'À relier à tes propres matériaux', surfaces: GENERIC },
};
export const DEFAULT_SURFACES = ALTIS;
