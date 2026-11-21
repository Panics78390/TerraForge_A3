// Jeux / moteurs pris en charge. Chaque profil dit quel export produire,
// quelles surfaces proposer par défaut et quelles fonctions afficher.
//   exp : 'tb' (Terrain Builder : Arma 3, DayZ), 'roblox', 'unreal', 'unity', 'generic'
export const GAMES = [
  { id: 'arma3', name: 'Arma 3', tool: 'Terrain Builder', exp: 'tb', surfaceSet: 'altis', rv: true, color: '#6f8f3a',
    desc: 'Export complet pour Terrain Builder : relief, satellite, masque, objets, routes.' },
  { id: 'dayz', name: 'DayZ', tool: 'Terrain Builder (DayZ Tools)', exp: 'tb', surfaceSet: 'dayz', rv: true, color: '#8a3b2e',
    desc: 'Même chaîne qu\'Arma 3, avec une configuration et des surfaces DayZ.' },
  { id: 'reforger', name: 'Arma Reforger', tool: 'World Editor (Workbench)', exp: 'generic', surfaceSet: 'generic', color: '#4d6a8a',
    desc: 'Relief 16 bits, couches de surface et image à importer dans le World Editor.' },
  { id: 'roblox', name: 'Roblox', tool: 'Roblox Studio', exp: 'roblox', surfaceSet: 'roblox', color: '#c23b3b',
    desc: 'Relief et carte des matériaux pour l\'importeur de terrain de Roblox Studio.' },
  { id: 'fortnite', name: 'Fortnite', tool: 'UEFN (Unreal Editor for Fortnite)', exp: 'unreal', surfaceSet: 'generic', color: '#7a4fd0',
    desc: 'Relief 16 bits et couches de peinture pour un Landscape UEFN.' },
  { id: 'unreal', name: 'Unreal Engine', tool: 'Unreal Engine (Landscape)', exp: 'unreal', surfaceSet: 'generic', color: '#3d4350',
    desc: 'Relief 16 bits et couches de peinture pour un Landscape.' },
  { id: 'unity', name: 'Unity', tool: 'Unity (Terrain)', exp: 'unity', surfaceSet: 'generic', color: '#2f7d7a',
    desc: 'Relief RAW 16 bits et couches de texture pour un Terrain Unity.' },
  { id: 'other', name: 'Autre jeu', tool: 'ton moteur de jeu', exp: 'generic', surfaceSet: 'generic', color: '#6b6f78',
    desc: 'Fichiers standards : relief (PNG 16 bits, RAW, ASC), couches, image, objets.' },
];
export const gameById = (id) => GAMES.find((g) => g.id === id) || GAMES[0];
