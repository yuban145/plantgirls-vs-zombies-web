// Local server for the standalone release. Uses only Node.js built-ins.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const port = Number(process.env.PORT || 5189);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.css':'text/css', '.txt':'text/plain; charset=utf-8', '.webp':'image/webp', '.png':'image/png', '.ogg':'audio/ogg', '.ttf':'font/ttf', '.otf':'font/otf' };
const server = http.createServer((req,res) => {
  let file;
  try {
    const url = new URL(req.url, 'http://localhost');
    file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  } catch { res.writeHead(400);res.end();return; }
  if (!file.startsWith(root + path.sep)) {res.writeHead(403);res.end();return;}
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405);res.end();return;}
  fs.stat(file, (err,stat) => {
    if(err || !stat.isFile()) {res.writeHead(404);res.end();return;}
    res.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream', 'Content-Length':stat.size});
    if(req.method === 'HEAD') {res.end();return;}
    const stream=fs.createReadStream(file);
    stream.on('error',()=>res.destroy());stream.pipe(res);
  });
});
server.on('error', err=>{console.error(err.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{
  console.log('植物娘大战僵尸 · 网页移植版');
  console.log('原作者：庄不纯');
  console.log(`打开浏览器： http://127.0.0.1:${port}/`);
  console.log('保持此窗口打开，按 Ctrl+C 停止。');
});
