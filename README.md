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
- Memory-friendly: only the current video ± 1 neighbor preload sources; far-away videos release their buffers;
- Supported formats: mp4 / m4v / webm / ogv / ogg / mov / mkv / avi / flv / ts / mpg / mpeg / 3gp / wmv (decoding depends on Chromium; a codec it can't handle shows a "can't play" card and auto-skips).

### Security boundaries

- The host half registers only `/video-player`-prefixed routes; **GET/HEAD only** — the plugin is strictly read-only, there is no write route;
- File access is limited to the video extension whitelist above, regular files only; Range offsets are validated against file size;
- Directory listings are capped (2000 files / depth 8); unreadable entries are silently skipped;
- Accessible paths = whatever the local shell can read (the GUI listens on 127.0.0.1 by default);
- SMB input is resolved by parsing `mount` output — **credentials never touch the plugin** (mounting is system-level: Finder ⌘K / `mount_smbfs`); a dropped mount yields a "please remount" hint instead of a raw EIO.

### Files

| File | Role |
| --- | --- |
| `package.json` | Package manifest + `dsh.bundle` (install layer) + `dsh.client` (browser-half discovery) |
| `cordis.patch.yml` | Bundle patch layer activated by `dsh plugin add`; registers the `video-player` Loader row |
| `index.js` | Host half (node): `/video-player/list` (browsing) + `/video-player/stream` (Range streaming) routes, incl. SMB path resolution |
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
- **抖音式刷视频**：整屏 scroll-snap 吸附 + 景深动画（当前视频放大、上下略缩小变暗）；一个播完**自动切下一个**，全部刷完出现「已刷完」卡片；
- 切换：`↑`/`↓` 键、鼠标滚轮、或**按住视频上下拖拽**（1:1 跟手，松手自动停靠到最近的视频；拖拽中自动暂停、松手恢复）；
- 快进快退：`←`/`→` 键 ±5 秒（带 ⏩/⏪ 大提示），底部进度条可点击跳转；
- 播放控制：`空格` 或单击视频暂停/播放；`M` 静音；`Esc` 或 ✕ 关闭；自动播放被浏览器拦截时降级为静音并显示「解除静音」提示；
- **窗口随视频宽高比自适应**：窗口按当前视频比例适配，默认大小为原始尺寸的 **1/4**（过小等比放大到 240px 下限，过大缩进视口内）；竖屏↔横屏切换实时变形；手动调整尺寸后停止自适应；
- **鼠标离开自动隐藏**：鼠标移出窗口后，标题栏、右下角缩放手柄、顶/底信息栏淡出——窗口变成纯视频画面（移入即恢复，鼠标指针也隐藏）；
- 右下角 ⋱ 手柄可调窗口大小（最小 240×240）；标题栏可拖动，位置 + 尺寸 + 自适应状态记在 `sessionStorage`；**双击标题栏**同时复位位置并恢复自动适配；
- 全屏：`F` 或 ⛶ 按钮；`Esc` 先退出全屏，第二次 `Esc`（或 ✕）关窗；
- **SMB NAS**：共享挂载在运行 dsh 的机器上后，可直接输入挂载点路径、`smb://主机/共享名/子目录` 或 `\\主机\共享名\子目录` —— 宿主解析 `mount` 输出自动换算成本地挂载路径（中文共享名的原始/percent-encoded 形式都能匹配）；未挂载时给出具体挂载命令；
- `/video-player/stream` Range 流式播放（HTTP 206）：快进/拖动进度条只发分段请求，不整段下载；
- 内存友好：只预载当前视频 ±1 个邻位，远离当前视频的自动释放缓冲；
- 支持格式：mp4 / m4v / webm / ogv / ogg / mov / mkv / avi / flv / ts / mpg / mpeg / 3gp / wmv（能否解码取决于 Chromium，常见编码没问题；不支持的编码会显示「无法播放」卡片并自动跳过）。

### 安全边界

- 宿主半边只注册 `/video-player` 前缀路由；**仅 GET/HEAD** —— 插件是纯只读的，没有任何写入路由；
- 文件访问只允许上述视频扩展名白名单且只允许常规文件；Range 偏移按文件大小校验；
- 目录清单有上限（2000 个 / 深度 8 层），不可读条目静默跳过；
- 可访问路径 = 本机 shell 可读范围（GUI 默认只绑定 127.0.0.1）；
- SMB 输入靠解析 `mount` 输出换算，**凭据不经过本插件**（挂载由系统完成：Finder ⌘K / `mount_smbfs`）；挂载断开后给出「请重新挂载」提示而非裸 EIO 错误。

### 文件

| 文件 | 说明 |
| --- | --- |
| `package.json` | 包清单 + `dsh.bundle`（安装层）+ `dsh.client`（浏览器半边发现） |
| `cordis.patch.yml` | 由 `dsh plugin add` 激活的 bundle 补丁层；注册 `video-player` Loader 行 |
| `index.js` | 宿主半边（node）：`/video-player/list`（浏览）+ `/video-player/stream`（Range 流式）路由，含 SMB 路径解析 |
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
