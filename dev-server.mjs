// Local dev server: serves /public and mounts the Netlify function at /api/*  (uses in-memory store).
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import api from "./netlify/functions/api.mjs";
const root = path.resolve("public"), port = process.env.PORT || 8888;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost:" + port);
  if (u.pathname.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await api(new Request(u, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), { ip: req.socket.remoteAddress });
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let f = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log("PulseVault dev server on http://localhost:" + port));
