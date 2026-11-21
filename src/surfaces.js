// Types de surface : couleur du masque (exportée pour Terrain Builder / layers.cfg)
// et couleur d'affichage (aperçu, image satellite).
export const DEFAULT_SURFACES = [
  { id: 'grass',    name: 'Herbe',        mask: [0, 255, 0],     sat: [92, 118, 58] },
  { id: 'grassdry', name: 'Herbe sèche',  mask: [255, 255, 0],   sat: [150, 140, 85] },
  { id: 'forest',   name: 'Sol forestier',mask: [0, 128, 0],     sat: [62, 74, 40] },
  { id: 'dirt',     name: 'Terre',        mask: [128, 64, 0],    sat: [118, 96, 70] },
  { id: 'sand',     name: 'Sable',        mask: [255, 200, 128], sat: [196, 180, 140] },
  { id: 'rock',     name: 'Roche',        mask: [128, 128, 128], sat: [120, 116, 110] },
  { id: 'gravel',   name: 'Gravier',      mask: [200, 200, 200], sat: [150, 146, 136] },
  { id: 'concrete', name: 'Béton',        mask: [0, 0, 255],     sat: [140, 140, 140] },
];
