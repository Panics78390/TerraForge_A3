# TerraForge A3

Éditeur de terrain simplifié pour Arma 3. On voit la carte en 3D en direct, on la modifie au pinceau, puis on exporte des fichiers prêts à importer dans Terrain Builder.

## Fonctions

- **Aperçu 3D en temps réel** avec la mer au niveau 0 m, comme dans Arma 3.
- **Relief** : élever / abaisser, lisser, aplanir à un niveau précis (Ctrl+clic pour prendre une altitude).
- **Eau** : creuser sous le niveau de la mer avec des berges douces.
- **Peinture de surfaces** : herbe, terre, sable, roche, etc. Sert au masque et à l'image satellite.
- **Objets** : pose, déplacement, rotation, échelle. Import de modèles 3D (GLB, GLTF, OBJ) comme aperçu.
- **Pinceau forêt** : mélange d'essences, densité, espacement, échelle et rotation aléatoires, pente maximale, gomme.
- **Routes** : tracé par points avec courbes lissées, plusieurs types, nivellement du terrain sous la route.
- **Projet** : enregistrement / ouverture (`.tfa3`), annuler / rétablir, import de relief (ASC ou image en niveaux de gris).

## Export vers Terrain Builder

Le bouton « Exporter vers Terrain Builder » crée un `.zip` contenant :

| Fichier | Rôle |
| --- | --- |
| `heightmap.asc` (et `.xyz` en option) | Relief |
| `sat/sat.png` | Image satellite |
| `mask/mask.png` + `mask/layers.cfg` | Masque de surface et couches |
| `objets/objets_terrain_builder.txt` | Objets (`"Nom";X;Y;Yaw;Pitch;Roll;Scale;Z;`) |
| `routes/roads.shp/.shx/.dbf` + `RoadsLib.cfg` | Routes (polylignes avec champ `ID`) |
| `LISEZMOI.txt` | Étapes d'import et valeurs du Mapframe |

## Limites

- La compilation finale (WRP puis PBO) se fait toujours avec les outils Arma 3 : Terrain Builder puis Addon Builder ou pboProject.
- Les fichiers `.p3d` d'Arma ne sont pas lus. Un modèle importé sert d'aperçu ; c'est le « nom Terrain Builder » saisi qui est exporté, et il doit exister dans ta bibliothèque TB.
- Les objets de base sont affichés sous forme simplifiée (cônes, sphères, boîtes).
- Arma 3 n'a d'eau native que sous 0 m : pas de lacs en altitude sans objets d'eau de mods.
- L'image satellite générée est une base simple (couleurs de surface + ombrage).

## Lancer

```bash
npm install
npm run dev            # développement
npm run build:single   # un seul fichier dist-single/index.html, à ouvrir par double-clic
```
