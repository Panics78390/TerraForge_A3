# TerraForge

Éditeur de terrain simplifié pour Arma 3. On voit la carte en 3D en direct, on la modifie au pinceau, puis on exporte des fichiers prêts à importer dans Terrain Builder.

## Fonctions

- **Import du monde réel** : on cherche un lieu, on cadre la zone, et TerraForge récupère le relief (tuiles Terrarium, environ 30 m), les routes, forêts, plans d'eau et bâtiments (OpenStreetMap, licence ODbL à créditer).
- **Assistant « Nouvelle carte »** : nom du mod, taille de carte (repères Stratis, Malden, Tanoa, Altis), style de relief (plat, collines, hauts plateaux, montagnes), curseurs de dénivelé, rugosité, crêtes et érosion, mer et côtes (île, presqu'île, côte, archipel), rivières par sources, volcan, canyon, plateaux, cratère, aperçu 2D et 3D en direct, choix des surfaces (jeu Altis / Stratis ou générique).
- **Aperçu 3D en temps réel** avec la mer au niveau 0 m, comme dans Arma 3.
- **Relief** : élever / abaisser, lisser, aplanir à un niveau précis (Ctrl+clic pour prendre une altitude).
- **Eau** : creuser sous le niveau de la mer avec des berges douces.
- **Peinture de surfaces** : herbe, terre, sable, roche, etc. Sert au masque et à l'image satellite.
- **Objets** : pose, déplacement, rotation, échelle. Import de modèles 3D (GLB, GLTF, OBJ) comme aperçu.
- **Pinceau forêt** : mélange d'essences, densité, espacement, échelle et rotation aléatoires, pente maximale, gomme.
- **Routes** : tracé par points avec courbes lissées, plusieurs types, nivellement du terrain sous la route.
- **Projet** : enregistrement / ouverture (`.tfa3`), annuler / rétablir, import de relief (ASC ou image en niveaux de gris).

## Vrais modèles Arma 3

Le bouton **🎮 Modèles Arma 3** (catalogue du bas) permet d'indiquer où se trouvent tes modèles :

- des fichiers **.pbo** du jeu ou d'un mod (dossier `Arma 3\Addons` : `structures_f*.pbo`, `plants_f.pbo`, `rocks_f.pbo`…) ;
- ou un **dossier** entier (Addons, dossier de mod, lecteur `P:`).

TerraForge lit directement les `.p3d` binarisés (ODOL) et leurs textures `.paa`, sans rien copier ni envoyer.
Les modèles apparaissent dans le catalogue avec leur vignette, se posent sur la carte, et sont exportés sous le nom du fichier `.p3d`.
Les objets du catalogue par défaut dont le nom correspond sont remplacés par le vrai modèle.

Limites : il faut redonner l'emplacement à chaque ouverture (sécurité du navigateur), les fichiers `.ebo` (DLC chiffrés) et les `.p3d` non binarisés (MLOD) ne sont pas lus, et seule la texture de couleur est affichée.

## Export vers Terrain Builder

Le bouton « Exporter vers Terrain Builder » crée un `.zip` contenant le dossier du mod, à décompresser sur `P:` :

| Fichier | Rôle |
| --- | --- |
| `config.cpp` | Base de configuration du monde (hérite de Stratis, à compléter) |
| `source/<nom>.asc` (et `.xyz` en option) | Relief |
| `source/<nom>_sat.png` | Image satellite |
| `source/<nom>_mask.png` + `source/layers.cfg` | Masque de surface et couches |
| `source/<nom>_objets.txt` | Objets (`"Nom";X;Y;Yaw;Pitch;Roll;Scale;Z;`) |
| `data/roads/roads.shp/.shx/.dbf` + `RoadsLib.cfg` | Routes (polylignes avec champ `ID`) |
| `LISEZMOI.txt` | Étapes d'import et valeurs du Mapframe |

## Limites

- La compilation finale (WRP puis PBO) se fait toujours avec les outils Arma 3 : Terrain Builder puis Addon Builder ou pboProject.
- Les fichiers `.p3d` d'Arma ne sont pas lus. Un modèle importé sert d'aperçu ; c'est le « nom Terrain Builder » saisi qui est exporté, et il doit exister dans ta bibliothèque TB.
- Les objets de base sont affichés sous forme simplifiée (cônes, sphères, boîtes).
- Arma 3 n'a d'eau native que sous 0 m : pas de lacs en altitude sans objets d'eau de mods.
- Les rivières creusent leur vallée et leur lit ; l'eau en altitude demande des objets « étang » dans Arma 3.
- Les chemins `.rvmat` du jeu de surfaces Altis / Stratis (`a3\map_data`) sont à vérifier sur ton lecteur P:.
- L'image satellite générée est une base simple (couleurs de surface + ombrage).

## Version en ligne

`docs/index.html` contient l'application en un seul fichier. Active GitHub Pages (Settings → Pages → branche `main`, dossier `/docs`) pour l'utiliser à l'adresse `https://panics78390.github.io/TerraForge_A3/`. `npm run build:pages` la met à jour.

## Lancer

```bash
npm install
npm run dev            # développement
npm run build:single   # un seul fichier dist-single/index.html, à ouvrir par double-clic
```

## Ouvrir un projet Terrain Builder (.tv4p)

« Ouvrir projet » accepte aussi les fichiers `.tv4p`. TerraForge y lit la taille de la carte et les chemins du relief (`.asc`), de l'image satellite, du masque et de `layers.cfg`, puis demande le dossier qui contient ces fichiers (par ex. `P:\macarte\source`). Les objets des calques (`.tv4l`) ne sont pas encore lus. Le projet Terrain Builder n'est jamais modifié.
