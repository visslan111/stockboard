# 部署说明

目标：把一个纯静态目录 + 一层同源反代跑起来，得到一个功能完整的看盘站。

```
浏览器 ──> Nginx :80 ──┬─ /            → 静态文件（index.html …）
                       ├─ /api/qq/     → proxy.finance.qq.com   （前复权日K）
                       ├─ /api/qq2/    → web.ifzq.gtimg.cn      （分时/成交额）
                       ├─ /api/qt/     → qt.gtimg.cn            （实时报价）
                       ├─ /api/em/     → push2.eastmoney.com    （板块/资金）
                       └─ /api/emh/    → push2his.eastmoney.com （历史K/历史资金）
```

---

## 1. 上传静态文件

```bash
scp -r stockboard/* user@host:/var/www/stockboard/
```

至少需要这些文件（缺一个页面就会报错）：

```
index.html  sectors.html  tailbuy.html
bank-panel.js  fund-panel.js  stocks.js
chart.umd.min.js  chartjs-plugin-zoom.min.js  hammer.min.js
```

## 2. 配置反代

```bash
sudo cp docs/nginx-proxy.example.conf /etc/nginx/conf.d/stockboard-api.conf
sudo mkdir -p /var/cache/nginx/quote && sudo chown -R nginx:nginx /var/cache/nginx
# 改 server_name / root 后
sudo nginx -t && sudo systemctl reload nginx
```

## 3. 验证

```bash
curl -s http://your.domain.com/api/ping
curl -s "http://your.domain.com/api/qt/q=sh600519" | head -c 200
curl -s "http://your.domain.com/api/em/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f100&secids=1.600519,0.000001"
```

三个都拿到数据，打开首页就应该能看到实时价格和板块列。

---

## 4. 东财 502 的应对：本地网关

东财源站会按 **TLS 客户端指纹** 拦截：

- nginx（OpenSSL 1.1.1d）直连 → `upstream prematurely closed connection`（502）
- Python ssl → `RemoteDisconnected`
- 偶发拿到 openresty 的 403

libcurl 的特征可以通过，所以用 `tools/em-gw.py` 起一个小网关，nginx 只负责同源、缓存和并发配额：

```bash
# 依赖：python3 + curl
sudo cp tools/em-gw.py /usr/local/emgw/ && chmod +x /usr/local/emgw/em-gw.py

# 三个实例分别对应 push2 / push2his / push2ex
/usr/local/emgw/em-gw.py 8099 push2.eastmoney.com 15
/usr/local/emgw/em-gw.py 8100 push2his.eastmoney.com 30
/usr/local/emgw/em-gw.py 8101 push2ex.eastmoney.com 15
```

systemd 单元示例（`/etc/systemd/system/em-gw-em.service`）：

```ini
[Unit]
Description=EastMoney quote gateway (push2)
After=network.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/emgw/em-gw.py 8099 push2.eastmoney.com 15
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now em-gw-em em-gw-emh em-gw-emx
```

然后把 nginx 的 `/api/em/`、`/api/emh/`、`/api/emx/` 改成反代本地端口：

```nginx
location ^~ /api/em/  { rewrite ^/api/em/(.*)$  /$1 break; proxy_pass http://127.0.0.1:8099; ... }
location ^~ /api/emh/ { rewrite ^/api/emh/(.*)$ /$1 break; proxy_pass http://127.0.0.1:8100; ... }
location ^~ /api/emx/ { rewrite ^/api/emx/(.*)$ /$1 break; proxy_pass http://127.0.0.1:8101; ... }
```

---

## 5. 几个坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面有价格但板块列一直是 ⟳ 重试 | `/api/em/` 未通或被拦 | 先 curl 验证 `/api/em/...`；必要时上 `em-gw.py` |
| 日K 全部空白 | 反代 501 / 超时 | 检查 `/api/qq/` 的 `Referer` 与 UA 头 |
| 首次打开慢 10 秒 | 上游排队，首屏并发多 | 已有 15s 超时保护；可加大 `proxy_cache_valid` |
| 换了 IP 后突然全挂 | 客户端 IP 段被上游 WAF 拦 | 这正是用同源反代的原因——确认没退回直连 |
| 二次打开还是旧页面 | 浏览器缓存 HTML | 给静态资源加版本号或 `Cache-Control: no-cache` |

## 6. 关于 HTTPS

行情接口反代走同源，**不需要** HTTPS 也能工作；但浏览器「桌面通知」和麦克风/语音相关能力在非安全上下文有受限，需要通知功能时建议配好证书。

## 7. 更新代码后

```bash
scp index.html user@host:/var/www/stockboard/
# 校验一致
md5sum index.html && ssh user@host "md5sum /var/www/stockboard/index.html"
```

改 nginx 配置前先备份：`cp stockboard-api.conf /root/backup/`。
