#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东财行情本地网关： nginx  ->  本服务  ->  curl  ->  东财

背景
----
东方财富源站 WAF 会按 TLS 客户端指纹拦截：
  - nginx（自带 OpenSSL 1.1.1d）直连  -> upstream prematurely closed connection（502）
  - Python ssl                      -> RemoteDisconnected
  - 偶发拿到 openresty 的 403
而 libcurl 的客户端特征可以通过。因此用 curl 子进程做转发，
nginx 只负责同源、缓存和并发配额。

用法
----
    em-gw.py <listen_port> <upstream_host> [cache_ttl]

例：
    em-gw.py 8099 push2.eastmoney.com 15
    em-gw.py 8100 push2his.eastmoney.com 30
"""

import sys
import time
import threading
import socketserver
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer


class ThreadedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """Python 3.6 没有 http.server.ThreadingHTTPServer（3.7 才有），这里自己拼一个"""
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128          # 默认只有 5，nginx 稍一并发就被拒

PORT = int(sys.argv[1])
HOST = sys.argv[2]
TTL = int(sys.argv[3]) if len(sys.argv) > 3 else 20

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
REF = "https://quote.eastmoney.com/"

_cache = {}
_lock = threading.Lock()
_sem = threading.Semaphore(8)          # 同时最多 8 个 curl，避免把上游打爆

# 上游失败时用「过期缓存」兜底：盘中宁可显示 10 分钟内的旧图，也不要整块空白。
# 超过 STALE_MAX 才判定失败，避免把明显过期的价格一直端给用户。
STALE_MAX = 600

# 上游除瞬时速率外还有「累计配额」，短时间打太多会进入几分钟的惩罚期，
# 因此全局串行排队，保证任意请求之间的最小间隔
_rate_lock = threading.Lock()
_last_ts = [0.0]
MIN_GAP = 0.34                          # ≈ 3 次/秒（东财按 IP 记累计配额，打快了直接进惩罚期）


def throttle():
    with _rate_lock:
        now = time.time()
        wait = _last_ts[0] + MIN_GAP - now
        if wait > 0:
            time.sleep(wait)
            now = time.time()
        _last_ts[0] = now


def cache_get(key, allow_stale=False):
    with _lock:
        v = _cache.get(key)
    if not v:
        return None
    ts, body = v
    age = time.time() - ts
    if age <= TTL:
        return body
    if allow_stale and age <= STALE_MAX:
        return body                     # 上游挂了，退回旧数据（调用方会带 X-GW-Stale 头）
    if not allow_stale:
        with _lock:
            _cache.pop(key, None)
    return None


def cache_put(key, body):
    with _lock:
        if len(_cache) > 3000:
            _cache.clear()
        _cache[key] = (time.time(), body)


def fetch(path):
    """curl 取数。上游偶发掐连接只重试 5xx/网络错误，404 之类的业务错直接放过"""
    url = "https://" + HOST + path
    cmd = ["curl", "-s", "--max-time", "15", "--compressed",
           "-H", "Referer: " + REF,
           "-H", "User-Agent: " + UA,
           "-H", "Accept: application/json, text/plain, */*",
           "-w", "\\n%{http_code}", url]
    BACKOFF = (0.5, 1.2, 2.4, 4.0)
    for attempt in range(5):
        throttle()
        with _sem:
            try:
                p = subprocess.run(cmd, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, timeout=20)
                out = p.stdout or b""
            except Exception:
                out = b""
        if out:
            body, _, code = out.rpartition(b"\n")
            try:
                code = int(code)
            except ValueError:
                code = 0
            if code == 200 and body:
                return body
            if 400 <= code < 500:
                return None            # 业务错误，重试没意义
        if attempt < 4:
            time.sleep(BACKOFF[attempt])
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, stale=False):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if stale:
            self.send_header("X-GW-Stale", "1")
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        key = self.path
        body = cache_get(key)
        stale = False
        if body is None:
            body = fetch(key)
            if body is None:
                body = cache_get(key, allow_stale=True)
                stale = True
                if body is None:
                    self._send(502, b"{}")
                    return
            else:
                cache_put(key, body)
        self._send(200, body, stale)


if __name__ == "__main__":
    srv = ThreadedHTTPServer(("127.0.0.1", PORT), Handler)
    srv.serve_forever()
