<p align="center">
	<a href="#english">English</a>&nbsp;&nbsp;|&nbsp;&nbsp;
	<a href="#%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87">简体中文</a>
</p>

<br>

# DSH Video Player / DSH 刷视频

<p align="center">
	<b>DSH web GUI client plugin: TikTok-style vertical video feed in a floating window.</b><br>
	<b>DSH web GUI 客户端插件：浮动窗口里的抖音式竖屏刷视频（窗口随视频自适应 + SMB NAS）。</b>
</p>

---

## English

A client plugin for the DSH web GUI: adds a "video" button at the bottom of the sidebar. Clicking it opens a floating window where you point at a folder (local or SMB-mounted), press "play this folder", and swipe through its videos TikTok-style — arrow keys, mouse wheel, or drag.

### Features

- Directory browsing: enter an absolute path (defaults to the current session's working directory) — lists subdirectories plus all videos inside (recursive, depth 8 / 2000-file cap); "▶ Play this folder" starts the feed;
- **TikTok-style feed**: full-screen scroll-snap + depth animation (current video scaled up, neighbors shrunk and dimmed); a finished video auto-advances to the next, and an "all done" card appears at the end;
- Switching: `↑`/`↓` keys, mouse wheel, or **drag on the video** (1:1 tracking; releases dock to the nearest video; paused while dragging, resumes on release);
- Seeking: `←`/`→` ±5 seconds with a ⏩/⏪ flash; the bottom progress bar is click-to-seek;
- Playback: `Space` or single-click toggles pause; `M` mutes; `Esc` or ✕ closes; auto-play blocked by the browser degrades to muted with an "unmute" hint;
- **Aspect-ratio auto-fit**: the window fits the current video's ratio at **¼ of the native size** (240 px floor, viewport-clamped); switching between portrait/landscape re-fits live; manual resizing turns auto-fit off;
- **Auto-hide UI**: mouse leaving the window fades out the title bar, resize handle and top/bottom info bars — a pure video window (restored on mouse enter; the cursor hides too);
- Resizable via the bottom-right ⋱ handle (min 240×240); title bar is draggable — position + size + auto-fit state are remembered in `sessionStorage`; double-click the title bar to reset position **and** re-enable auto-fit;
- Fullscreen: `F` or the ⛶ button; `Esc` exits fullscreen first, second `Esc` (or ✕) closes the window;
- **SMB NAS**: with the share mounted on the dsh host, accept the mount-point path, `smb://host/share/sub`, or `\\host\share\sub` — the host resolves it to the local mount by parsing `mount` output (Chinese share names in raw or percent-encoded form all match);
- Range streaming via `/video-player/stream` (HTTP 206) — seeking sends ranged requests, never a full-file download;
- **Online videos (yt-dlp)**: paste a yt-dlp-supported video / playlist / uploader URL into the same address bar (bilibili, YouTube, …) — the list is fetched via `--flat-playlist` (in-memory, 30 min); single-file progressive streams are proxied by the host (browser UA + Referer + Cookie, Range passed through); DASH/HLS segment streams (all bilibili) are auto-downloaded and merged to a local mp4 (≤1080p, needs ffmpeg) and then served as a local Range stream — each video downloads once, replays are instant;
- **Generic page fallback (no per-site code)**: when yt-dlp cannot extract a list at all, the host fetches the page itself and scans the HTML for direct media links (tag attributes, inline JSON, JSON-LD — escaped or not), normalizes vendor URL quirks (trailing slashes, prefers signed/`?token=` variants over bare duplicates) and lists whatever it finds for you to pick — covers "plain" sites with no yt-dlp extractor;
- **bilibili 1080p**: with a logged-in cookies.txt selected, bilibili single videos prefer a one-time 1080p DASH download into the cache (instant replay after); anonymous (or cookie-less) falls back to the instant 480p progressive relay;
- **Login state (cookies.txt)**: the 🍪 row in the browse card selects / uploads / deletes a browser-exported `cookies.txt` (stored under `~/.dsh/video-player/cookies/`); only non-expired, domain-matching cookies are forwarded (a whole-browser export stays under CDN header limits); needed for high-quality / members-only / login-gated content;
- **yt-dlp & ffmpeg discovery** (no machine-specific paths in the repo): local config `~/.dsh/video-player/config.json` → `{"ytdlp": "<path>", "ffmpeg": "<path-or-dir>", "extractorArgs": ["generic:impersonate", "youtube:player_client=mweb,android"]}` > `DVP_YTDLP` env > PATH (`yt-dlp` / `yt-dlp.exe`) > `python -m yt_dlp`; the first candidate that answers `--version` wins (cached); each `extractorArgs` entry is passed as its own `--extractor-args` flag (re-read on every call — no restart needed);
- **Chat push (agent)**: the dsh agent can push a video into the player — `POST /video-player/queue {"url","title"}` (in-memory, 10 items max, 30 min TTL); an open player window polls every 2 s and auto-plays the first pending item (📥 toast); while the window is closed the items wait and play as soon as it opens; the agent can search first with yt-dlp (`bilisearch5:<topic>` / `ytssearch5:<topic>`) and push the pick;
- **Cache cleanup**: the 🧹 button in the cookie row shows the DASH-merge cache size and clears it with one confirm (`GET/DELETE /video-player/cache`; files locked by active playback are skipped and reported).
- Memory-friendly: only the current video ± 1 neighbor preload sources; far-away videos release their buffers;
- Supported formats: mp4 / m4v / webm / ogv / ogg / mov / mkv / avi / flv / ts / mpg / mpeg / 3gp / wmv (decoding depends on Chromium; a codec it can't handle shows a "can't play" card and auto-skips).

### Security boundaries

- The host half registers only `/video-player`-prefixed routes; **list/stream are GET/HEAD only** — write routes: `/video-player/cookies` (POST upload / DELETE, name-validated `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, 5 MB cap, stored under `~/.dsh/video-player/cookies/`), `/video-player/cache` (DELETE, only the plugin's own cache dir), `/video-player/queue` (POST, in-memory push queue — no file or network side effects);
- File access is limited to the video extension whitelist above, regular files only; Range offsets are validated against file size;
- Directory listings are capped (2000 files / depth 8); unreadable entries are silently skipped;
- Accessible paths = whatever the local shell can read (the GUI listens on 127.0.0.1 by default);
- SMB input is resolved by parsing `mount` output — **credentials never touch the plugin** (mounting is system-level: Finder ⌘K / `mount_smbfs`); a dropped mount yields a "please remount" hint instead of a raw EIO.

### Files

| File | Role |
| --- | --- |
| `package.json` | Package manifest + `dsh.bundle` (install layer) + `dsh.client` (browser-half discovery) |
| `cordis.patch.yml` | Bundle patch layer activated by `dsh plugin add`; registers the `video-player` Loader row |
| `index.js` | Host half (node): `/video-player/list` (local + yt-dlp remote lists) + `/video-player/stream` (local Range / online proxy / DASH cache download) + `/video-player/cookies` (GET/POST/DELETE) + `/video-player/cache` (GET/DELETE) + `/video-player/queue` (GET/POST), incl. SMB path resolution |
| `client.js` | Browser half (classic script bundle, no build step) |

### Install

Install the official runtime with Node.js:

```sh
npx @deepseek-ai/dsh web
```

Install this plugin into a profile (the ecosystem convention):

```sh
dsh plugin --profile web add "github:anitman/dsh-plugin-video-player#main"
```

`dsh plugin` forwards package operations to pnpm, so npm, Git/GitHub, local path, `file:` and `link:` package specs are all supported — e.g. from a local clone:

```sh
dsh plugin --profile web add .
```

Only packages declaring `dsh.bundle.patch` become active profile layers; this package declares it, so `dsh plugin add` completes the link and layer activation in one step. Pure JS, no build scripts — a git install needs **no** `allowBuilds` approval.

**Restart `dsh --profile web`** after installing or updating a bundle: the "▶ 刷视频" button then appears at the bottom of the sidebar (above the settings button); manage it under **Settings → Plugins**.

#### Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-video-player
```

Removes the dependency and the patch layer together; restart dsh to take effect.

#### Manual fallback (without the dsh CLI)

1. Create a symlink `dsh-plugin-video-player` in `~/.dsh/profiles/web/node_modules/` pointing at this directory (or copy the directory if symlinks fail);
2. Add to `dependencies` in `~/.dsh/profiles/web/package.json`: `"dsh-plugin-video-player": "file:<absolute path to this repo>"`;
3. Append to the top-level array of `~/.dsh/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: video-player
         name: "dsh-plugin-video-player"
   ```
4. **Restart the dsh process** (new Loader rows are only scanned at startup; sessions restore automatically).

### Updating

- Only `client.js` changed: no restart needed, client-HMR hot-reloads the plugin (requires the host-side watch chain to be active; otherwise refresh the page);
- `index.js` (host half) changed: dsh restart required;
- Local clone installed via `add .`: `git pull`, then restart dsh;
- Installed via `github:`: re-run the install command with a new `#ref` to upgrade;
- If node_modules holds a copy instead of a symlink: re-copy after changes (or switch back to a symlink).

---

## 简体中文

DSH web GUI 客户端插件：侧栏底部多一个「▶ 刷视频」按钮，点开是一个浮动窗口，指向一个文件夹（本地或 SMB 挂载的 NAS）后按「播放此文件夹」，即可抖音式连续刷视频。

### 功能

- 目录浏览：输入绝对路径（默认填入当前会话工作目录），列出子目录 + 该目录（含子目录，深度 8 层、最多 2000 个）内的全部视频，点「▶ 播放此文件夹」开始刷；
- **抖音式刷视频**：整屏 scroll-snap 吸附 + 景深动画（当前视频放大、上下略缩小变暗）；一个播完**自动切下一个**（顶栏 **🔁 循环** 按钮可切换为循环重播当前视频，选择持久化），全部刷完出现「已刷完」卡片；
- 切换：`↑`/`↓` 键、鼠标滚轮、或**按住视频上下拖拽**（1:1 跟手，松手自动停靠到最近的视频；拖拽中自动暂停、松手恢复）；
- 快进快退：`←`/`→` 键 ±5 秒（带 ⏩/⏪ 大提示），底部进度条可点击跳转；
- 播放控制：`空格` 或单击视频暂停/播放；`M` 静音；`Esc` 或 ✕ 关闭；自动播放被浏览器拦截时降级为静音并显示「解除静音」提示；
- **窗口随视频宽高比自适应**：窗口按当前视频比例适配，默认大小为原始尺寸的 **1/4**（过小等比放大到 240px 下限，过大缩进视口内）；竖屏↔横屏切换实时变形；手动调整尺寸仅作用于当前视频，切换到新视频时窗口自动恢复按宽高比适配；
- **鼠标离开自动隐藏**：鼠标移出窗口后，标题栏、右下角缩放手柄、顶/底信息栏淡出——窗口变成纯视频画面（移入即恢复，鼠标指针也隐藏）；
- 右下角 ⋱ 手柄可调窗口大小（最小 240×240）；标题栏可拖动，位置 + 尺寸 + 自适应状态记在 `sessionStorage`；**双击标题栏**同时复位位置并恢复自动适配；
- 全屏：`F` 或 ⛶ 按钮；`Esc` 先退出全屏，第二次 `Esc`（或 ✕）关窗；
- **SMB NAS**：共享挂载在运行 dsh 的机器上后，可直接输入挂载点路径、`smb://主机/共享名/子目录` 或 `\\主机\共享名\子目录` —— 宿主解析 `mount` 输出自动换算成本地挂载路径（中文共享名的原始/percent-encoded 形式都能匹配）；未挂载时给出具体挂载命令；
- `/video-player/stream` Range 流式播放（HTTP 206）：快进/拖动进度条只发分段请求，不整段下载；
- **在线视频（yt-dlp）**：地址栏直接粘贴 yt-dlp 支持的视频/UP主/播放列表网址（bilibili、YouTube 等）——列表内存缓存 30 分钟；单文件渐进流由宿主代理转发（补浏览器 UA/Referer/Cookie，Range 透传）；DASH/HLS 分段流（bilibili 全 DASH）自动下载合并为本地 mp4（≤1080p，需 ffmpeg）再本地 Range 播放，同一视频只下一次、之后秒开；
- **通用页面兜底（零站点特判）**：yt-dlp 完全提不出列表时，宿主自己抓页面 HTML，用通用规则（标签属性 / 内联 JSON / JSON-LD，含转义斜杠形式）扫出媒体直链，归一化站方怪写法（尾斜杠、同路径优先保留带 `?token=` 签名的变体）后全部列出让用户挑——覆盖没有 yt-dlp 提取器的"朴素"站点；
- **bilibili 1080p**：选中已登录的 cookies.txt 时，bilibili 单视频优先一次性下载 1080p DASH 进缓存（之后秒播）；无登录态则回落到即时的 480p 渐进流代理；
- **登录态（cookies.txt）**：浏览卡片里的 🍪 一行可选择/上传/删除浏览器导出的 cookies.txt（存于 `~/.dsh/video-player/cookies/`）；只转发未过期且域匹配的条目（整浏览器导出也不会超 CDN 头限制）；高清/会员/需登录内容必备；
- **yt-dlp 与 ffmpeg 定位**（仓库不含任何机器特定路径）：本机配置 `~/.dsh/video-player/config.json` → `{"ytdlp": "<路径>", "ffmpeg": "<路径或目录>", "extractorArgs": ["generic:impersonate", "youtube:player_client=mweb,android"]}` > 环境变量 `DVP_YTDLP` > PATH（`yt-dlp`/`yt-dlp.exe`）> `python -m yt_dlp`；第一个能通过 `--version` 的候选胜出并缓存；`extractorArgs` 每条作为独立 `--extractor-args` 传入，每次调用重读配置（改完即生效，不用重启）；
- **对话推送（agent）**：dsh agent 可以把视频推进播放器 —— `POST /video-player/queue {"url","title"}`（纯内存，最多 10 条，30 分钟过期）；打开中的播放窗口每 2 秒轮询一次，自动播放第一条待播视频（📥 提示）；窗口没开时视频先排队，开窗即播；agent 可先用 yt-dlp 搜索（`bilisearch5:<话题>` / `ytssearch5:<话题>`）挑一个再推；
- **缓存清理**：🍪 一行的 🧹 按钮显示 DASH 合并缓存的大小，点一下确认即清空（`GET/DELETE /video-player/cache`；正在播放占用的文件跳过并报告）。
- 内存友好：只预载当前视频 ±1 个邻位，远离当前视频的自动释放缓冲；
- 支持格式：mp4 / m4v / webm / ogv / ogg / mov / mkv / avi / flv / ts / mpg / mpeg / 3gp / wmv（能否解码取决于 Chromium，常见编码没问题；不支持的编码会显示「无法播放」卡片并自动跳过）。

### 安全边界

- 宿主半边只注册 `/video-player` 前缀路由；**list/stream 仅 GET/HEAD**；写入路由：`/video-player/cookies`（POST 上传 / DELETE，名称白名单 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`、正文 ≤5MB，只写入 `~/.dsh/video-player/cookies/`）、`/video-player/cache`（DELETE，只动插件自己的缓存目录）、`/video-player/queue`（POST，纯内存推送队列，无文件/网络副作用）；
- 文件访问只允许上述视频扩展名白名单且只允许常规文件；Range 偏移按文件大小校验；
- 目录清单有上限（2000 个 / 深度 8 层），不可读条目静默跳过；
- 可访问路径 = 本机 shell 可读范围（GUI 默认只绑定 127.0.0.1）；
- SMB 输入靠解析 `mount` 输出换算，**凭据不经过本插件**（挂载由系统完成：Finder ⌘K / `mount_smbfs`）；挂载断开后给出「请重新挂载」提示而非裸 EIO 错误。

### 文件

| 文件 | 说明 |
| --- | --- |
| `package.json` | 包清单 + `dsh.bundle`（安装层）+ `dsh.client`（浏览器半边发现） |
| `cordis.patch.yml` | 由 `dsh plugin add` 激活的 bundle 补丁层；注册 `video-player` Loader 行 |
| `index.js` | 宿主半边（node）：`/video-player/list`（本地目录 + yt-dlp 在线列表）+ `/video-player/stream`（本地 Range / 在线代理 / DASH 缓存下载）+ `/video-player/cookies` + `/video-player/cache` + `/video-player/queue`，含 SMB 路径解析 |
| `client.js` | 浏览器半边（classic script bundle，无构建步骤） |

### 安装

用 Node.js 安装官方运行时：

```sh
npx @deepseek-ai/dsh web
```

把本插件装入某个 profile（生态约定）：

```sh
dsh plugin --profile web add "github:anitman/dsh-plugin-video-player#ref"
```

`dsh plugin` 把包操作转发给 pnpm，因此 npm、Git/GitHub、本地路径、`file:`、`link:` 等包描述符都支持 —— 例如从本地 clone 安装：

```sh
dsh plugin --profile web add .
```

只有声明了 `dsh.bundle.patch` 的包才会成为生效的 profile 层；本包已声明，所以 `dsh plugin add` 一步完成链接与层激活。纯 JS、无构建脚本 —— git 安装**不需要** `allowBuilds` 审批。

安装/更新 bundle 后**重启 `dsh --profile web`** 生效：侧栏底部（设置按钮上方）出现「▶ 刷视频」按钮；可在 **设置 → 插件** 中管理。

#### 卸载

```sh
dsh plugin --profile web remove dsh-plugin-video-player
```

依赖与补丁层一并移除；重启 dsh 生效。

#### 手动安装（不使用 dsh CLI）

1. 在 `~/.dsh/profiles/web/node_modules/` 创建指向本目录的软链接 `dsh-plugin-video-player`（软链失败则直接拷贝目录）；
2. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加：`"dsh-plugin-video-player": "file:<本仓库绝对路径>"`；
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 顶层数组追加：
   ```yaml
   - insert:
       - id: video-player
         name: "dsh-plugin-video-player"
   ```
4. **重启 dsh 进程**（新 Loader 行只在启动时扫描；会话自动恢复）。

### 更新

- 只改了 `client.js`：无需重启，client-HMR 热加载插件（需要宿主侧 watch 链处于活动状态；否则刷新页面）；
- 改了 `index.js`（宿主半边）：必须重启 dsh；
- 本地 clone 通过 `add .` 安装的：`git pull` 后重启 dsh；
- 通过 `github:` 安装的：带新 `#ref` 重跑安装命令升级；
- node_modules 里是拷贝而非软链的：改动后重新拷贝（或改回软链）。
