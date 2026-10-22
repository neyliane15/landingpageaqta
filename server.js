// Servidor local que emula a Vercel: arquivos estáticos + funções em /api/*.js.
// Uso: node server.js  (porta via PORT, padrão 3000). Lê .env se existir.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const PRIVATE = /^\/(lib|tests|docs|node_modules|\.git|\.env|server\.js|package)/;

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname.startsWith('/api/')) {
        const name = pathname.slice(5).replace(/\/$/, '');
        const file = path.join(root, 'api', `${name}.js`);
        if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) {
          res.statusCode = 404; return res.end('{"error":"not_found"}');
        }
        req.query = Object.fromEntries(url.searchParams);
        req.body = await readBody(req);
        const mod = await import(pathToFileURL(file).href);
        return await mod.default(req, res);
      }
      if (PRIVATE.test(pathname)) { res.statusCode = 404; return res.end('Not found'); }
      if (pathname.endsWith('/')) pathname += 'index.html';
      let file = path.join(root, pathname);
      if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
      if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html'; // cleanUrls
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404; res.setHeader('Content-Type', TYPES['.html']);
        const nf = path.join(root, '404.html');
        return res.end(fs.existsSync(nf) ? fs.readFileSync(nf) : 'Not found');
      }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) { res.statusCode = 500; res.end('{"error":"internal"}'); }
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Aqta em http://localhost:${port}`));
}
