// Pont MCP de TerraForge : parle le protocole MCP sur l'entrée / sortie standard
// (pour l'appli Claude) et transmet chaque commande à TerraForge, qui écoute sur
// une adresse locale (127.0.0.1). Lancé par TerraForge.exe en mode « Node »
// (variable ELECTRON_RUN_AS_NODE=1) : aucune installation de Node n'est nécessaire.
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const infoPath = process.argv[2];
const readInfo = () => { try { return JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch { return null; } };

const TOOLS = [
  { name: 'etat', description: "État de TerraForge : carte ouverte, taille, nombre de routes et d'objets par modèle, modèles Arma 3 connectés, occupation en cours, dialogue ouvert.", inputSchema: { type: 'object', properties: {} } },
  { name: 'monde_reel', description: "Lance l'import « Monde réel » (relief, routes, sols, bâtiments, arbres, image satellite) centré sur lat/lon. Revient tout de suite : suivre avec `etat` (champ occupe/message) puis lire le résultat avec `dernier_import`.", inputSchema: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, taille_m: { type: 'number', description: 'Côté de la carte en mètres (1024 à 16384, défaut 4096)' }, nom: { type: 'string' }, relief: { type: 'boolean' }, satellite: { type: 'boolean' }, routes: { type: 'boolean' }, chemins: { type: 'boolean' }, sols: { type: 'boolean' }, arbres: { type: 'boolean' }, batiments: { type: 'boolean' }, densite_arbres: { type: 'number' } }, required: ['lat', 'lon'] } },
  { name: 'dernier_import', description: "Résultat du dernier import « Monde réel » lancé par `monde_reel` : durée, parties manquantes, cause par serveur, état de la carte.", inputSchema: { type: 'object', properties: {} } },
  { name: 'capture', description: "Capture d'écran de la fenêtre TerraForge (image JPEG).", inputSchema: { type: 'object', properties: { largeur: { type: 'number', description: 'Largeur maximale en pixels (défaut 1280)' } } } },
  { name: 'camera', description: "Place la caméra au-dessus du point (x, z) du monde, ou renvoie sa position si aucun argument.", inputSchema: { type: 'object', properties: { x: { type: 'number' }, z: { type: 'number' }, hauteur: { type: 'number' }, distance: { type: 'number' } } } },
  { name: 'fermer_dialogue', description: 'Ferme la fenêtre de dialogue ouverte dans TerraForge (message, assistant).', inputSchema: { type: 'object', properties: {} } },
  { name: 'journal', description: 'Derniers messages de la console de TerraForge (erreurs et avertissements), pour le diagnostic.', inputSchema: { type: 'object', properties: { max: { type: 'number' } } } },
  { name: 'js', description: "Exécute du JavaScript dans l'éditeur TerraForge (diagnostic et réglages). `code` est le corps d'une fonction asynchrone qui reçoit `tf` = { state, terrain, objects, roads, a3, camera, controls, api, geo } et doit renvoyer une valeur sérialisable en JSON.", inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
];

function post(info, body, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: info.port, path: '/call', method: 'POST', timeout, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-TerraForge-Token': info.token } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(new Error('réponse illisible de TerraForge')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TerraForge ne répond pas')));
    req.on('error', reject);
    req.end(data);
  });
}

// Appelle TerraForge ; s'il n'est pas ouvert, le lance et attend qu'il soit prêt.
async function call(tool, args) {
  let info = readInfo();
  try { if (info) return await post(info, { tool, args }); } catch { /* pas lancé : on le démarre */ }
  if (!info || !info.exe) throw new Error("TerraForge n'est pas ouvert. Lance TerraForge puis réessaie.");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(info.exe, [], { detached: true, stdio: 'ignore', env }).unref();
  let last;
  for (let k = 0; k < 40; k++) {
    await new Promise((r) => setTimeout(r, 1500));
    info = readInfo() || info;
    try { return await post(info, { tool, args }); } catch (err) { last = err; }
  }
  throw new Error(`TerraForge ne s'est pas ouvert (${last ? last.message : 'délai dépassé'}).`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'terraforge', version: '1.0.0' } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) throw new Error(`outil inconnu : ${name}`);
      const r = await call(name, (params && params.arguments) || {});
      if (r.error) throw new Error(r.error);
      const content = r.image ? [{ type: 'image', data: r.image, mimeType: 'image/jpeg' }] : [{ type: 'text', text: JSON.stringify(r.result, null, 1) }];
      return send({ jsonrpc: '2.0', id, result: { content } });
    } catch (err) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Erreur : ${err.message || err}` }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `méthode inconnue : ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let k;
  while ((k = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, k).trim();
    buf = buf.slice(k + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    pending++;
    handle(msg).catch((err) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err.message || err) } }); })
      .finally(() => { pending--; if (ended && !pending) process.exit(0); });
  }
});
// À la fermeture de l'entrée, on laisse finir les appels en cours avant de quitter.
let pending = 0, ended = false;
process.stdin.on('end', () => { ended = true; if (!pending) process.exit(0); });
