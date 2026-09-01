#!/usr/bin/env python3
# 用途：本地开发服务。静态托管仓库根目录（no-store，改完刷新即生效）+ POST /__save 写文件
#      （仅允许 artifacts/<项目>/src/tracks.js 或 src/**/*.json）+ /artifex/* 反向代理到 ARTIFEX
#      （utils/seedance.html 用；浏览器无法跨域，页面以 X-Authorization 头传凭证，代理转为 Authorization）。
# 用法：python3 utils/serve.py [port=8080]     （一般通过 utils/serve.sh 调用）
import json, os, re, sys, time
import urllib.request, urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import os as _os
# artifex 代理目标：环境变量 ARTIFEX_HOST 或 utils/artifex.host 文件（该文件已 gitignore，不入库）
_hostfile = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'artifex.host')
ARTIFEX = _os.environ.get('ARTIFEX_HOST') or (open(_hostfile).read().strip() if _os.path.exists(_hostfile) else '')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOW = re.compile(r'^artifacts/[^/.][^/]*/src/(tracks\.js|(?:[^/]+/)*[^/]+\.json)$')

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):   # 静态请求不刷屏；只打印保存与错误
        if args and str(args[1:2]) and not str(args[0]).startswith('GET'):
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy(self):
        url = ARTIFEX + self.path[len('/artifex'):]
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(url, data=body, method=self.command)
        if self.headers.get('Content-Type'):
            req.add_header('Content-Type', self.headers['Content-Type'])
        auth = self.headers.get('X-Authorization')
        if auth:
            req.add_header('Authorization', auth)
        req.add_header('Accept', 'application/json, */*')
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                code, data, ctype = r.status, r.read(), r.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            code, data, ctype = e.code, e.read(), e.headers.get('Content-Type', 'text/plain')
        except Exception as e:
            code, data, ctype = 502, json.dumps({'error': f'proxy: {e}'}, ensure_ascii=False).encode('utf-8'), 'application/json'
        print(f'[{time.strftime("%H:%M:%S")}] proxy {self.command} {url.split("?")[0]} -> {code}', flush=True)
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/artifex/'):
            return self._proxy()
        if self.headers.get('Range'):
            return self._serve_range()        # 视频 seek 依赖 HTTP Range（否则 Chrome seekable 为空、currentTime 赋值被忽略）
        return super().do_GET()

    def _serve_range(self):
        path = self.translate_path(self.path.split('?')[0])
        try:
            f = open(path, 'rb')
        except OSError:
            return self.send_error(404)
        try:
            size = os.fstat(f.fileno()).st_size
            m = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', ''))
            if not m:
                f.seek(0); start, end = 0, size - 1
            else:
                start = int(m.group(1) or 0)
                end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(end - start + 1))
            self.end_headers()
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)
        finally:
            f.close()

    def do_POST(self):
        if self.path.startswith('/artifex/'):
            return self._proxy()
        if self.path != '/__save':
            return self._json(404, {'error': 'unknown endpoint'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:
            return self._json(400, {'error': f'bad json: {e}'})
        path = body.get('path', '')
        if '..' in path or not ALLOW.match(path):
            return self._json(403, {'error': f'不允许写入: {path}'})
        full = os.path.join(ROOT, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        content = body.get('content', '')
        with open(full, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'[{time.strftime("%H:%M:%S")}] saved {path} ({len(content.encode("utf-8"))} bytes)', flush=True)
        self._json(200, {'ok': True, 'path': path})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'serving {ROOT} at http://127.0.0.1:{port}  (/__save + /artifex proxy -> {ARTIFEX})', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
