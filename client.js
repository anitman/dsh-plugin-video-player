/**
 * dsh-plugin-video-player — 浏览器半边（client bundle，classic script）。
 *
 * 侧栏底部「刷视频」按钮 + 浮动播放窗口（抖音式）：
 *   - 目录浏览：/video-player/list（子目录 + 递归视频清单），输入绝对路径跳转；
 *   - 竖屏刷视频：scroll-snap 整屏吸附 + 景深动画，播完自动切下一个；
 *   - 切换：↑↓ 键 / 滚轮 / 鼠标上下拖拽（1:1 跟手，松手停靠最近视频）；
 *   - 快进：←→ 键 ±5 秒（带 ⏩/⏪ 提示），底部进度条可点击跳转；
 *   - 空格/单击 暂停，M 静音（自动播放被拦时降级静音并提示），Esc 或 ✕ 关闭；
 *   - 窗口随视频宽高比自动适配（默认 1/4 原始尺寸），右下角 ⋱ 手柄手动缩放，
 *     双击标题栏恢复自动适配；标题栏可拖动（位置/尺寸记忆在 sessionStorage）；
 *   - 鼠标离开窗口 → 标题栏/手柄/顶底信息栏自动淡出（纯视频窗口），移入恢复；
 *   - F / ⛶ 浏览器全屏，Esc 先退全屏再关窗；
 *   - 视频经 /video-player/stream 流式播放（Range 支持快进）。
 *
 * 只依赖平台种子模块（react / react/jsx-runtime / react-dom），
 * 不引入任何 npm 包，因此无需构建步骤。
 * 颜色/字体全部使用 DSW 主题 token（定义在 body 上，portal 可继承）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-video-player",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxrt = require("react/jsx-runtime");
		let reactDom = require("react-dom");
		const { useState, useEffect, useRef, useCallback } = react;
		const { jsx, jsxs, Fragment } = jsxrt;
		/* 路径提示按平台区分：Windows 用 \\主机\共享（UNC），其他平台用 smb://主机/共享 */
		const isWin = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "");

		/* ── 样式（按 data-plugin 约定注入，HMR 重载时由宿主按 data-plugin 清除） ── */
		const css = [
			".vdpv-btn{width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:8px;justify-content:center;align-items:center;padding:0;display:inline-flex;cursor:pointer}",
			".vdpv-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".vdpv-btn-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".vdpv-panel{position:fixed;top:12px;right:12px;width:400px;height:min(760px,calc(100vh - 24px));z-index:2000;display:block;background:#000;color:#fff;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden;font-family:var(--dsw-font-family);font-size:13px;box-sizing:border-box}",
			".vdpv-panel:fullscreen{top:0;left:0;right:0;width:100vw;height:100vh;border:none;border-radius:0}",
			".vdpv-panel.idle{cursor:none}",
			/* 标题栏：顶部渐变覆盖层，鼠标离开窗口时自动滑出隐藏 */
			".vdpv-head{position:absolute;top:0;left:0;right:0;z-index:30;height:40px;gap:8px;align-items:center;padding:0 10px;display:flex;cursor:move;user-select:none;touch-action:none;background:linear-gradient(rgba(0,0,0,.78),rgba(0,0,0,.35) 70%,transparent);color:#fff;transition:opacity .18s ease,transform .18s ease;border-radius:12px 12px 0 0}",
			".vdpv-panel.idle .vdpv-head{opacity:0;transform:translateY(-104%);pointer-events:none}",
			".vdpv-hbtn{flex:none;width:26px;height:26px;justify-content:center;align-items:center;background:rgba(255,255,255,.12);border:none;border-radius:7px;color:#fff;font-size:13px;cursor:pointer;display:inline-flex}",
			".vdpv-hbtn:hover{background:rgba(255,255,255,.28)}",
			/* 右下角缩放手柄 */
			".vdpv-resize{position:absolute;right:0;bottom:0;z-index:35;width:20px;height:20px;cursor:nwse-resize;color:rgba(255,255,255,.65);font-size:14px;line-height:1;justify-content:center;align-items:flex-end;padding:2px 3px 0 0;display:flex;transition:opacity .18s ease}",
			".vdpv-resize:hover{color:#fff}",
			".vdpv-panel.idle .vdpv-resize{opacity:0;pointer-events:none}",
			".vdpv-panel:fullscreen .vdpv-resize{display:none}",
			".vdpv-title{font-size:13px;font-weight:600;flex:none}",
			".vdpv-sub{flex:1;min-width:0;color:rgba(255,255,255,.6);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:12px}",
			".vdpv-x{flex:none;width:26px;height:26px;justify-content:center;align-items:center;background:rgba(255,255,255,.12);border:none;border-radius:7px;color:#fff;font-size:13px;cursor:pointer;display:inline-flex}",
			".vdpv-x:hover{background:rgba(255,255,255,.28)}",
			".vdpv-body{position:absolute;inset:0;background:#000}",
			/* display:flex 会覆盖 [hidden] 的 UA 规则，显式兜底 */
			".vdpv-panel [hidden]{display:none!important}",
			".vdpv-body.idle .vdpv-topbar,.vdpv-body.idle .vdpv-bottombar{opacity:0;pointer-events:none}",
			/* 播放舞台 */
			".vdpv-stage{position:absolute;inset:0;overflow-y:auto;scroll-snap-type:y mandatory;overscroll-behavior:none;scrollbar-width:none;touch-action:none}",
			".vdpv-stage::-webkit-scrollbar{display:none}",
			".vdpv-stage.dragging{scroll-snap-type:y proximity}",
			".vdpv-slide{height:100%;scroll-snap-align:start;scroll-snap-stop:always;position:relative;display:flex;align-items:center;justify-content:center;background:#000;will-change:transform,opacity}",
			".vdpv-slide video{width:100%;height:100%;object-fit:contain;background:#000;display:block}",
			".vdpv-bad{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#ff8080;font-size:13px;line-height:1.8;background:rgba(0,0,0,.55);pointer-events:none}",
			/* 顶栏 / 底栏 */
			".vdpv-topbar{position:absolute;top:40px;left:0;right:0;z-index:10;gap:8px;align-items:center;padding:6px 10px 16px;display:flex;background:linear-gradient(rgba(0,0,0,.65),transparent);font-size:12px;transition:opacity .18s ease}",
			".vdpv-fname{max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.95}",
			".vdpv-topbar .vdpv-spacer{flex:1}",
			".vdpv-tbtn{flex:none;background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:7px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer}",
			".vdpv-tbtn:hover{background:rgba(255,255,255,.25)}",
			".vdpv-tbtn.active{background:rgba(255,59,92,.5)}",
			".vdpv-tbtn.active:hover{background:rgba(255,59,92,.65)}",
			".vdpv-bottombar{position:absolute;left:0;right:0;bottom:0;z-index:10;padding:24px 12px 8px;display:flex;flex-direction:column;gap:5px;background:linear-gradient(transparent,rgba(0,0,0,.78));transition:opacity .18s ease}",
			".vdpv-brow{gap:8px;align-items:center;display:flex;font-size:12px}",
			".vdpv-counter{flex:none;opacity:.8;font-size:11px}",
			".vdpv-time{flex:none;width:38px;text-align:center;font-size:11px;opacity:.85;font-variant-numeric:tabular-nums}",
			".vdpv-track{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.25);cursor:pointer;position:relative}",
			".vdpv-fill{height:100%;width:0%;border-radius:2px;background:#ff3b5c}",
			".vdpv-chip{position:absolute;top:44px;right:10px;z-index:11;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.3);color:#fff;font-size:11px;padding:4px 9px;border-radius:999px;cursor:pointer}",
			".vdpv-chip:hover{background:rgba(0,0,0,.78)}",
			/* 中央大提示 */
			".vdpv-flash{position:absolute;inset:0;z-index:9;justify-content:center;align-items:center;pointer-events:none;font-size:36px;font-weight:700;opacity:0;text-shadow:0 2px 18px rgba(0,0,0,.6);display:flex}",
			".vdpv-flash.small{font-size:54px}",
			".vdpv-flash.show{animation:vdpvFlash .65s ease-out forwards}",
			"@keyframes vdpvFlash{0%{opacity:0;transform:scale(.8)}25%{opacity:.95;transform:scale(1)}100%{opacity:0;transform:scale(1.05)}}",
			/* 卡片（浏览 / 状态 / 刷完） */
			".vdpv-card{position:absolute;inset:0;z-index:20;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center;background:rgba(0,0,0,.88);font-weight:600;display:flex}",
			".vdpv-card-sub{font-size:12px;font-weight:400;opacity:.65;max-width:300px;line-height:1.8;white-space:pre-line}",
			".vdpv-browse{width:100%;max-width:320px;flex-direction:column;gap:8px;margin-top:6px;display:flex}",
			".vdpv-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px}",
			".vdpv-rows{flex-direction:column;gap:2px;max-height:40vh;overflow:auto;display:flex}",
			".vdpv-row{width:100%;cursor:pointer;gap:8px;align-items:center;background:0 0;border:none;border-radius:6px;padding:6px 10px;font:inherit;font-size:13px;color:#fff;text-align:left;display:flex}",
			".vdpv-row:hover{background:rgba(255,255,255,.1)}",
			".vdpv-row-icon{flex:none;width:18px;text-align:center}",
			".vdpv-row-label{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".vdpv-playbtn{margin-top:4px;background:#ff3b5c;color:#fff;border:0;border-radius:10px;padding:10px 20px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}",
			".vdpv-playbtn:hover:not(:disabled){filter:brightness(1.1)}",
			".vdpv-playbtn:disabled{opacity:.45;cursor:default}"
		].join("\n");
		const tagId = "dsh-plugin-video-player/app.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-video-player";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* ── 基础工具 ── */
		async function api(pathname, query) {
			const res = await fetch(pathname + "?" + query, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			if (!body || body.ok !== true) throw new Error((body && body.error) || "HTTP " + res.status);
			return body;
		}
		const streamUrl = (path) => "/video-player/stream?path=" + encodeURIComponent(path);
		const el = (tag, cls) => {
			const n = document.createElement(tag);
			if (cls) n.className = cls;
			return n;
		};
		const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
		const fmtTime = (t) => {
			if (!Number.isFinite(t)) return "0:00";
			t = Math.max(0, Math.floor(t));
			return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
		};

		// 窗口按视频宽高比自动适配：默认取视频原始尺寸的 1/4，
		// 过小则等比放大到 240px 下限，过大则等比缩进视口。
		const MIN_SIZE = 240;
		// 浏览/未加载视频时的默认窗口尺寸（高度随视口自适应）
		const defaultSize = () => ({ w: 400, h: Math.min(760, Math.max(420, window.innerHeight - 24)) });
		function fitSize(vw, vh) {
			let w = vw / 4;
			let h = vh / 4;
			const smin = Math.max(MIN_SIZE / w, MIN_SIZE / h);
			if (smin > 1) {
				w *= smin;
				h *= smin;
			}
			const maxW = Math.max(MIN_SIZE, window.innerWidth - 24);
			const maxH = Math.max(MIN_SIZE, window.innerHeight - 24);
			const smax = Math.min(maxW / w, maxH / h);
			if (smax < 1) {
				w *= smax;
				h *= smax;
			}
			return { w: Math.round(w), h: Math.round(h) };
		}

		/* ── 窗口位置（拖动 + 记忆） ── */
		const POS_KEY = "vdpv.pos.v1";
		function readPos() {
			try {
				const s = sessionStorage.getItem(POS_KEY);
				if (!s) return null;
				const p = JSON.parse(s);
				return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w) && Number.isFinite(p.h) ? p : null;
			} catch {
				return null;
			}
		}
		function persistPos(p) {
			try {
				if (p === null) sessionStorage.removeItem(POS_KEY);
				else sessionStorage.setItem(POS_KEY, JSON.stringify(p));
			} catch {
				/* ignore */
			}
		}
		/* 循环播放开关（持久化：重开窗口仍记住选择） */
		const LOOP_KEY = "vdpv.loop.v1";
		function readLoop() {
			try { return localStorage.getItem(LOOP_KEY) === "1"; } catch { return false; }
		}
		function persistLoop(v) {
			try { localStorage.setItem(LOOP_KEY, v ? "1" : "0"); } catch { /* ignore */ }
		}

		/* ── 播放引擎（命令式 DOM；切换/拖拽/快进逻辑与独立验证过的版本一致） ── */
		const SEEK_STEP = 5;
		const NEIGHBOR = 1;

		function createEngine(root, opts) {
			const onTitle = opts.onTitle;
			const onClose = opts.onClose;
			const onFit = opts.onFit || (() => {});
			const onToggleFullscreen = opts.onToggleFullscreen || (() => {});

			/* DOM */
			const stage = el("div", "vdpv-stage");
			const topbar = el("div", "vdpv-topbar");
			topbar.hidden = true;
			const folderName = el("span", "vdpv-fname");
			const browseBtn = el("button", "vdpv-tbtn");
			browseBtn.type = "button";
			browseBtn.textContent = "更换文件夹";
			const loopBtn = el("button", "vdpv-tbtn");
			loopBtn.type = "button";
			loopBtn.textContent = "🔁 循环";
			loopBtn.title = "循环播放当前视频（关闭则播完自动切下一个）";
			const topSpacer = el("span", "vdpv-spacer");
			topbar.append(folderName, topSpacer, loopBtn, browseBtn);

			const chip = el("button", "vdpv-chip");
			chip.type = "button";
			chip.textContent = "🔇 点击解除静音（M）";
			chip.hidden = true;

			const bottombar = el("div", "vdpv-bottombar");
			bottombar.hidden = true;
			const brow1 = el("div", "vdpv-brow");
			const fileName = el("span", "vdpv-fname");
			const counter = el("span", "vdpv-counter");
			brow1.append(fileName, counter);
			const brow2 = el("div", "vdpv-brow");
			const timeNow = el("span", "vdpv-time");
			const track = el("div", "vdpv-track");
			const fill = el("div", "vdpv-fill");
			track.appendChild(fill);
			const timeDur = el("span", "vdpv-time");
			brow2.append(timeNow, track, timeDur);
			bottombar.append(brow1, brow2);

			const flashEl = el("div", "vdpv-flash");

			const card = el("div", "vdpv-card");
			const cardTitle = el("div", "vdpv-card-title");
			const cardSub = el("div", "vdpv-card-sub");
			const browseWrap = el("div", "vdpv-browse");
			const input = el("input", "vdpv-input");
			input.placeholder = isWin
				? "文件夹路径，如 \\192.168.1.100\\视频 或 smb://主机/共享，回车浏览"
				: "文件夹绝对路径 或 smb://主机/共享，回车浏览";
			const rows = el("div", "vdpv-rows");
			const playBtn = el("button", "vdpv-playbtn");
			playBtn.type = "button";
			browseWrap.append(input, rows, playBtn);
			card.append(cardTitle, cardSub, browseWrap);

			const endCard = el("div", "vdpv-card");
			endCard.hidden = true;
			const endTitle = el("div", "vdpv-card-title");
			const backTop = el("button", "vdpv-playbtn");
			backTop.type = "button";
			backTop.textContent = "回到顶部";
			endCard.append(endTitle, backTop);

			root.append(stage, topbar, chip, bottombar, flashEl, card, endCard);

			/* 状态 */
			let dir = null;
			let videos = []; // [{ name, path, video, slide, bad }]
			let idx = -1;
			let muted = false;
			let disposed = false;
			let scrollRaf = 0;
			let lastMeta = null; // 当前视频原生尺寸 { w, h }
			let settleIdx = -1; // 滚动正在停靠/已停靠的视频索引（-1 = 无目标，如浏览视图）
			let loop = readLoop(); // 循环播放：播完重播当前视频（默认关闭=自动切下一个）
			const styled = new Set();

			/* ── 卡片 / 浏览视图 ── */
			function setCard(title, sub, showBrowse) {
				cardTitle.textContent = title;
				cardSub.textContent = sub || "";
				browseWrap.style.display = showBrowse ? "" : "none";
				card.hidden = false;
			}

			function makeRow(icon, label, fn, title) {
				const r = el("button", "vdpv-row");
				r.type = "button";
				const ic = el("span", "vdpv-row-icon");
				ic.textContent = icon;
				const lb = el("span", "vdpv-row-label");
				lb.textContent = label;
				r.append(ic, lb);
				if (title) r.title = title;
				r.addEventListener("click", fn);
				return r;
			}

			function welcome() {
				setCard(
					"📺 刷视频",
					(/Windows/i.test(navigator.userAgent || "")
					? "输入文件夹路径，如 \\192.168.1.100\\共享（UNC 直读 NAS）。\n"
					: "输入本地文件夹绝对路径，或 smb://主机/共享（NAS 需先挂载）。\n") +
					"↑↓ / 拖拽 切换 · ←→ 快进 · 空格 暂停 · M 静音",
					true
				);
				input.value = "";
				rows.innerHTML = "";
				playBtn.textContent = "▶ 播放此文件夹";
				playBtn.disabled = true;
				onTitle("");
			}

			async function loadDir(p) {
				setCard("正在加载…", p, true);
				input.value = p;
				try {
					const data = await api("/video-player/list", "dir=" + encodeURIComponent(p));
					if (disposed) return;
					dir = data.dir;
					input.value = dir;
					renderBrowse(data);
				} catch (e) {
					if (disposed) return;
					setCard("无法打开目录", (e && e.message ? e.message : String(e)) + "\n" + p, true);
				}
			}

			function renderBrowse(data) {
				stopPlayback();
				endCard.hidden = true;
				card.hidden = false;
				cardTitle.textContent = "📺 刷视频";
				cardSub.textContent =
					"此文件夹 " + data.videos.length + " 个视频" + (data.truncated ? "（已达上限）" : "") +
					"\n↑↓ / 拖拽 切换 · ←→ 快进 · 空格 暂停 · M 静音";
				rows.innerHTML = "";
				if (data.parent) rows.appendChild(makeRow("↑", "上一级", () => loadDir(data.parent), data.parent));
				for (const d of data.dirs) rows.appendChild(makeRow("📁", d.name, () => loadDir(d.path), d.path));
				playBtn.textContent = data.videos.length
					? "▶ 播放此文件夹（" + data.videos.length + " 个视频）"
					: "此文件夹没有视频";
				playBtn.disabled = !data.videos.length;
				playBtn.onclick = () => startPlay(data);
				onTitle(data.dir);
			}

			/* ── 播放视图 ── */
			function startPlay(data) {
				videos = data.videos.map((v) => ({ name: v.name, path: v.path }));
				if (!videos.length) return;
				dir = data.dir;
				card.hidden = true;
				endCard.hidden = true;
				topbar.hidden = false;
				bottombar.hidden = false;
				folderName.textContent = "📁 " + data.dir;
				endTitle.textContent = "🎉 已刷完全部 " + videos.length + " 个视频";
				renderSlides();
				stage.scrollTop = 0;
				idx = 0;
				updateIndex(0);
				settleIdx = 0;
				applyDepth();
			}

			function stopPlayback() {
				for (const v of videos) {
					try {
						v.video.pause();
						v.video.removeAttribute("src");
						v.video.load();
					} catch {
						/* ignore */
					}
				}
				videos = [];
				idx = -1;
				settleIdx = -1;
				topbar.hidden = true;
				bottombar.hidden = true;
				chip.hidden = true;
			}
			browseBtn.addEventListener("click", () => (dir ? loadDir(dir) : welcome()));
			backTop.addEventListener("click", () => goTo(0));

			function renderSlides() {
				stage.innerHTML = "";
				styled.clear();
				for (let index = 0; index < videos.length; index++) {
					const v = videos[index];
					const slide = el("div", "vdpv-slide");
					const video = document.createElement("video");
					video.preload = "auto";
					video.playsInline = true;
					const bad = el("div", "vdpv-bad");
					bad.hidden = true;
					const k = index;
					video.addEventListener("error", () => {
						bad.textContent = "⚠️ 该视频无法播放（浏览器可能不支持其编码）\n" + v.name;
						bad.hidden = false;
					});
					// 只有“结束时仍是当前视频”才触发自动切换
					video.addEventListener("ended", () => {
						if (idx === k) onEnded();
					});
					// 元数据是一次性事件：预载的相邻视频可能先于“成为当前”就触发，
// 因此缓存每个视频的尺寸，updateIndex 时按当前索引补发。
					video.addEventListener("loadedmetadata", () => {
						const vw = video.videoWidth;
						const vh = video.videoHeight;
						if (!vw || !vh) return;
						videos[k].meta = { w: vw, h: vh };
						if (idx === k && !disposed) {
							lastMeta = videos[k].meta;
							onFit(vw, vh, k);
						}
					});
					// 上报原生尺寸：窗口自动匹配视频宽高比（默认 1/4 大小）
					video.addEventListener("loadedmetadata", () => {
						if (idx === k && video.videoWidth && video.videoHeight) {
							lastMeta = { w: video.videoWidth, h: video.videoHeight };
							if (onFit) onFit(video.videoWidth, video.videoHeight, k);
						}
					});
					slide.appendChild(video);
					slide.appendChild(bad);
					stage.appendChild(slide);
					v.video = video;
					v.slide = slide;
					v.bad = bad;
				}
			}

			// play() 返回 Promise：启动期间 paused 仍为 true，且再次 play() 会 abort 上一次
// （AbortError）。统一走 playVideo/pauseVideo：pending 保护防止重复请求；
// pause() 幂等，并顺带取消尚在启动中的播放。
			function playVideo(v) {
				if (!v || !v.video.getAttribute("src")) return;
				if (v.video.paused && !v.__playPending) {
					v.__playPending = true;
					v.video.play().catch((e) => {
						v.__playPending = false;
						// 仅当“自动播放被策略拦截”时降级静音；被用户 pause 打断（AbortError）不处理
						if (e && e.name === "NotAllowedError") autoMute(v);
					}).then(() => {
						v.__playPending = false;
					});
				}
			}
			function pauseVideo(v) {
				if (!v) return;
				v.__playPending = false;
				v.video.pause();
			}

			function updateIndex(i) {
				if (i < 0 || i >= videos.length) return;
				idx = i;
				for (let k = 0; k < videos.length; k++) {
					const v = videos[k];
					const d = Math.abs(k - i);
					if (d <= NEIGHBOR) {
						if (!v.video.getAttribute("src")) v.video.src = streamUrl(v.path);
						v.video.muted = muted;
						if (k === i) {
							if (v.video.ended) v.video.currentTime = 0;
							playVideo(v);
						} else {
							pauseVideo(v);
						}
					} else if (v.video.getAttribute("src")) {
						// 远离当前：释放缓冲
						pauseVideo(v);
						v.video.removeAttribute("src");
						v.video.load();
					}
				}
				fileName.textContent = videos[i].name;
				counter.textContent = (i + 1) + " / " + videos.length;
				timeNow.textContent = "0:00";
				timeDur.textContent = "0:00";
				fill.style.width = "0%";
				endCard.hidden = true;
				onTitle(videos[i].name);
				// 元数据可能在成为当前之前就已到达（邻位预载）：回放一次，
				// 让窗口按当前视频宽高比自适应
				const m = videos[i].meta;
				if (m) {
					lastMeta = m;
					onFit(m.w, m.h, i);
				}
			}

			function goTo(i) {
				if (!videos.length) return;
				i = Math.max(0, Math.min(videos.length - 1, i));
				if (i === idx) return;
				endCard.hidden = true;
				smoothScrollTo(i * stage.clientHeight, i);
			}

			// Chrome 已知问题：mandatory 吸附下平滑滚动会卡住/回弹，
			// 因此过渡期间临时关闭吸附，动画结束后再恢复。
			// forIdx：本次滚动的目标视频索引，供窗口自适应改高时重定位（防漂移）。
			function smoothScrollTo(top, forIdx) {
				if (forIdx != null) settleIdx = forIdx;
				stage.style.scrollSnapType = "none";
				const onEnd = () => {
					stage.removeEventListener("scrollend", onEnd);
					if (!dragging) stage.style.scrollSnapType = "";
				};
				stage.addEventListener("scrollend", onEnd);
				stage.scrollTo({ top, behavior: "smooth" });
				setTimeout(onEnd, 800);
			}

			// 拖拽松手：手动停靠到最近的视频（不依赖原生吸附）
			function dockToNearest() {
				const h = stage.clientHeight || 1;
				const n = Math.max(0, Math.min(videos.length - 1, Math.round(stage.scrollTop / h)));
				const target = n * h;
				stage.classList.remove("dragging");
				if (Math.abs(stage.scrollTop - target) < 2) {
					settleIdx = -1;
					return;
				}
				smoothScrollTo(target, n);
			}

			// 窗口自适应/手动缩放会改变舞台高度，此时所有视频位置（= 索引×高度）都变了。
			// 若滚动停在过渡目标上，按新高度瞬时重定位到同一视频（避免落到相邻视频）；
			// 瞬时赋值同时中止在途的旧平滑滚动。拖拽中不动（用户直接控制 scrollTop）。
			const settleRO = new ResizeObserver(() => {
				if (disposed || dragging || !videos.length) return;
				// 过渡中用目标索引，已停靠则用当前索引，保证高度变化后仍对准同一视频
				const targetIdx = settleIdx >= 0 ? settleIdx : idx;
				if (targetIdx < 0) return;
				const h = stage.clientHeight || 1;
				const target = targetIdx * h;
				if (Math.abs(stage.scrollTop - target) >= 2) stage.scrollTop = target;
			});
			settleRO.observe(stage);
			stage.addEventListener("scrollend", () => {
				const h = stage.clientHeight || 1;
				if (settleIdx < 0) return;
				if (Math.abs(stage.scrollTop - settleIdx * h) < 2) settleIdx = -1;
			});

			function onEnded() {
				if (loop) {
					const v = videos[idx];
					if (v && v.video.getAttribute("src")) {
						v.video.currentTime = 0;
						playVideo(v);
					}
					return;
				}
				if (idx < videos.length - 1) goTo(idx + 1);
				else endCard.hidden = false;
			}

			function autoMute(v) {
				// 自动播放被浏览器拦截时，降级为静音播放
				if (!muted) {
					muted = true;
					chip.hidden = false;
				}
				v.video.muted = true;
				v.video.play().catch(() => {}); // 静音后重试一次
			}
			chip.addEventListener("click", toggleMute);

			/* 循环开关：🔁 播放完重播当前视频 ↔ 自动切下一个视频 */
			function applyLoopUI() {
				loopBtn.classList.toggle("active", loop);
				loopBtn.title = loop
					? "循环播放已开启：播完重播当前视频（点击切换为自动切视频）"
					: "自动切视频已开启：播完播下一个（点击开启循环播放）";
			}
			loopBtn.addEventListener("click", () => {
				loop = !loop;
				applyLoopUI();
				persistLoop(loop);
				flash(loop ? "🔁 循环播放：播完重播当前视频" : "自动切视频：播完播下一个", true);
			});
			applyLoopUI();

			/* ── 快进 / 暂停 / 静音 / 提示 ── */
			function flash(text, small) {
				flashEl.textContent = text;
				flashEl.classList.toggle("small", !!small);
				flashEl.classList.remove("show");
				void flashEl.offsetWidth; // 重启动画
				flashEl.classList.add("show");
			}

			function seek(dt) {
				const v = videos[idx];
				if (!v || !v.video.getAttribute("src")) return;
				const dur = v.video.duration;
				if (!Number.isFinite(dur)) return;
				v.video.currentTime = Math.max(0, Math.min(dur - 0.05, v.video.currentTime + dt));
				flash(dt > 0 ? "⏩ +" + dt + "s" : "⏪ -" + Math.abs(dt) + "s");
				playVideo(v); // 暂停中则恢复；播放中无副作用；pending 中不重复请求
			}

			function togglePlay() {
				const v = videos[idx];
				if (!v) return;
				if (v.video.paused && !v.__playPending) {
					playVideo(v);
					flash("▶", true);
				} else {
					pauseVideo(v);
					flash("⏸", true);
				}
			}

			function toggleMute() {
				muted = !muted;
				const v = videos[idx];
				if (v) v.video.muted = muted;
				chip.hidden = !muted;
			}

			/* ── 滚动：索引同步 + 景深 ── */
			stage.addEventListener("scroll", () => {
				if (scrollRaf) return;
				scrollRaf = requestAnimationFrame(() => {
					scrollRaf = 0;
					const h = stage.clientHeight || 1;
					const cur = Math.max(0, Math.min(videos.length - 1, Math.round(stage.scrollTop / h)));
					applyDepth();
					if (cur !== idx) updateIndex(cur);
				});
			});

			function applyDepth() {
				if (!videos.length) return;
				const h = stage.clientHeight || 1;
				const t = stage.scrollTop / h;
				const lo = Math.max(0, Math.floor(t) - 3);
				const hi = Math.min(videos.length - 1, Math.floor(t) + 3);
				for (let k = lo; k <= hi; k++) {
					const off = Math.abs(k - t);
					const s = Math.max(0.9, 1 - 0.1 * off);
					const o = Math.max(0.5, 1 - 0.45 * off);
					const sl = videos[k].slide;
					sl.style.transform = "scale(" + s.toFixed(3) + ")";
					sl.style.opacity = o.toFixed(3);
					styled.add(k);
				}
				for (const k of [...styled]) {
					if (k < lo || k > hi) {
						const sl = videos[k] && videos[k].slide;
						if (sl) {
							sl.style.transform = "scale(0.9)";
							sl.style.opacity = "0.5";
						}
						styled.delete(k);
					}
				}
			}

			/* ── 鼠标拖拽切换（抖音式，1:1 跟手） ── */
			let dragging = false;
			let dragLastY = 0;
			let dragMoved = 0;
			let dragWasPlaying = false;

			stage.addEventListener("pointerdown", (e) => {
				if (e.button !== 0 || !videos.length) return;
				const v = videos[idx];
				// 含“正在启动播放”的状态：paused 在 play() pending 期间仍为 true
				dragWasPlaying = !!(v && (!v.video.paused || v.__playPending));
				dragging = true;
				dragMoved = 0;
				dragLastY = e.clientY;
				stage.classList.add("dragging");
				stage.style.scrollSnapType = "none";
				// 若还有在途的平滑滚动（如刚按键切换），立即终止，避免动画覆盖拖拽。
				// 直接赋值 scrollTop 会中止进行中的平滑滚动（scrollTo behavior:auto 未必能）。
				stage.scrollTop = Math.round(stage.scrollTop);
				stage.setPointerCapture(e.pointerId);
				if (v) pauseVideo(v); // 拖拽时暂停
			});
			stage.addEventListener("pointermove", (e) => {
				if (!dragging) return;
				// 相对上一次事件增量推进：即使浏览器中途动了 scrollTop 也跟手
				const dy = e.clientY - dragLastY;
				dragLastY = e.clientY;
				dragMoved = Math.max(dragMoved, Math.abs(dy));
				stage.scrollTop -= dy; // 往下拖 → 上一条
			});
			const endDrag = () => {
				if (!dragging) return;
				dragging = false;
				const v = videos[idx];
				if (dragMoved < 6) {
					// 视为点击：切换播放/暂停（相对点击前状态）
					stage.classList.remove("dragging");
					stage.style.scrollSnapType = "";
					if (v) {
						if (dragWasPlaying) pauseVideo(v);
						else playVideo(v);
					}
				} else {
					if (dragWasPlaying) playVideo(v);
					dockToNearest();
				}
			};
			stage.addEventListener("pointerup", endDrag);
			stage.addEventListener("pointercancel", endDrag);

			/* ── 键盘 ── */
			function onKey(e) {
				const t = e.target;
				if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
					if (e.key === "Escape") t.blur();
					return;
				}
				if (e.key === "Escape") {
					// 全屏中：先退出全屏（部分浏览器会把 Esc 交给页面处理），下一次 Esc 再关窗
					if (document.fullscreenElement) {
						document.exitFullscreen().catch(() => {});
						return;
					}
					onClose();
					return;
				}
				if (e.key === "f" || e.key === "F") {
					onToggleFullscreen();
					return;
				}
				if (!videos.length) return;
				switch (e.key) {
					case "ArrowRight": e.preventDefault(); seek(SEEK_STEP); break;
					case "ArrowLeft": e.preventDefault(); seek(-SEEK_STEP); break;
					case "ArrowDown": e.preventDefault(); goTo(idx + 1); break;
					case "ArrowUp": e.preventDefault(); goTo(idx - 1); break;
					case " ": e.preventDefault(); togglePlay(); break;
					case "m": case "M": toggleMute(); break;
				}
			}
			window.addEventListener("keydown", onKey);

			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const p = input.value.trim();
					if (p) loadDir(p);
				}
			});

			/* ── 进度条点击跳转 ── */
			track.addEventListener("click", (e) => {
				const v = videos[idx];
				if (!v || !Number.isFinite(v.video.duration) || !v.video.duration) return;
				const r = track.getBoundingClientRect();
				const p = clamp((e.clientX - r.left) / r.width, 0, 1);
				v.video.currentTime = p * v.video.duration;
			});

			/* ── 进度渲染循环 ── */
			(function tick() {
				if (disposed) return;
				const v = videos[idx];
				if (v && v.video.getAttribute("src")) {
					const d = v.video.duration;
					if (Number.isFinite(d) && d > 0) {
						const c = v.video.currentTime;
						fill.style.width = (100 * c / d).toFixed(2) + "%";
						timeNow.textContent = fmtTime(c);
						timeDur.textContent = fmtTime(d);
					}
				}
				requestAnimationFrame(tick);
			})();

			/* ── 生命周期 ── */
			function dispose() {
				if (disposed) return;
				disposed = true;
				window.removeEventListener("keydown", onKey);
				stopPlayback();
				if (scrollRaf) cancelAnimationFrame(scrollRaf);
				settleRO.disconnect();
				root.innerHTML = "";
			}

			welcome();
			return {
				loadDir,
				welcome,
				dispose,
				// 双击标题栏恢复自动适配时，重新按已知尺寸适配一次
				refit: () => {
					if (lastMeta && !disposed) onFit(lastMeta.w, lastMeta.h, idx);
				}
			};
		}

		/* ── 浮动面板：可拖动 / 右下角缩放 / 全屏 / 鼠标离开自动隐藏边栏 / 窗口随视频宽高比自动适配 ── */
		function VideoPlayerPanel(props) {
			const home = props.home;
			const onClose = props.onClose;
			const panelRef = useRef(null);
			const bodyRef = useRef(null);
			const titleRef = useRef(null);
			const engineRef = useRef(null);
			const dragRef = useRef(null);
			const resizeRef = useRef(null);
			const lastFitVideoRef = useRef(-1); // 上次 onFit 的视频索引（切到新视频→按宽高比重置窗口）

			// 恢复会话记忆：位置 + 手动尺寸（fit=false 时）
			const initRef = useRef(null);
			if (!initRef.current) {
				const p = readPos();
				initRef.current = p
					? { pos: { x: p.x, y: p.y }, size: p.fit === false && p.w && p.h ? { w: p.w, h: p.h } : null }
					: { pos: null, size: null };
			}
			const [pos, setPos] = useState(initRef.current.pos);
			const [size, setSize] = useState(initRef.current.size); // null = 自动适配
			const [meta, setMeta] = useState(null); // 当前视频原生尺寸
			const [idle, setIdle] = useState(false);
			const [isFs, setIsFs] = useState(false);
			const autoFitRef = useRef(initRef.current.size === null);

			// 生效尺寸：手动尺寸 > 视频适配（默认 1/4）> 浏览默认
			const eff = size || (meta ? fitSize(meta.w, meta.h) : defaultSize());

			function toggleFullscreen() {
				const el = panelRef.current;
				if (!el) return;
				if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
				else el.requestFullscreen().catch(() => {});
			}

			useEffect(() => {
				const onFs = () => setIsFs(!!document.fullscreenElement);
				document.addEventListener("fullscreenchange", onFs);
				return () => document.removeEventListener("fullscreenchange", onFs);
			}, []);

			useEffect(() => {
				const body = bodyRef.current;
				if (!body) return undefined;
				const engine = createEngine(body, {
					onTitle: (text) => {
						if (titleRef.current) titleRef.current.textContent = text || "";
					},
					onClose,
					onFit: (w, h, videoIndex) => {
						// 切到新视频：窗口按新视频宽高比重新适配（清掉上一条视频遗留的手动尺寸）
						if (videoIndex !== lastFitVideoRef.current) {
							lastFitVideoRef.current = videoIndex;
							setSize(null);
							autoFitRef.current = true;
						}
						setMeta({ w, h });
					},
					onToggleFullscreen: toggleFullscreen
				});
				engineRef.current = engine;
				if (home) engine.loadDir(home);
				else engine.welcome();
				return () => {
					engine.dispose();
					engineRef.current = null;
				};
			}, [home, onClose]);

			// 尺寸变化时把被拖走的位置钳回视口
			useEffect(() => {
				if (!pos) return;
				const x = clamp(pos.x, 0, Math.max(0, window.innerWidth - eff.w));
				const y = clamp(pos.y, 0, Math.max(0, window.innerHeight - eff.h));
				if (x !== pos.x || y !== pos.y) setPos({ x, y });
			}, [pos, eff.w, eff.h]);

			const persistBox = () => {
				const panel = panelRef.current;
				if (!panel) return;
				const r = panel.getBoundingClientRect();
				persistPos({ x: r.left, y: r.top, w: r.width, h: r.height, fit: autoFitRef.current });
			};

			/* 标题栏拖动（只改位置） */
			const onHeaderPointerDown = (e) => {
				if (e.button !== 0) return;
				if (e.target.closest("button, input, a")) return;
				const panel = panelRef.current;
				if (!panel) return;
				const rect = panel.getBoundingClientRect();
				dragRef.current = {
					px: e.clientX,
					py: e.clientY,
					x: rect.left,
					y: rect.top,
					w: rect.width,
					h: rect.height
				};
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
			};
			const onHeaderPointerMove = (e) => {
				const start = dragRef.current;
				if (!start) return;
				const x = clamp(start.x + (e.clientX - start.px), 0, Math.max(0, window.innerWidth - start.w));
				const y = clamp(start.y + (e.clientY - start.py), 0, Math.max(0, window.innerHeight - start.h));
				setPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
			};
			const onHeaderPointerUp = (e) => {
				if (!dragRef.current) return;
				dragRef.current = null;
				try {
					e.currentTarget.releasePointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
				persistBox();
			};
			// 双击：复位位置 + 恢复自动适配
			const onHeaderDoubleClick = () => {
				setPos(null);
				setSize(null);
				autoFitRef.current = true;
				persistPos(null);
				if (engineRef.current) engineRef.current.refit();
			};

			/* 右下角缩放手柄（手动调尺寸后停止自动适配） */
			const onResizeDown = (e) => {
				if (e.button !== 0 || isFs) return;
				resizeRef.current = { px: e.clientX, py: e.clientY, w: eff.w, h: eff.h };
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
			};
			const onResizeMove = (e) => {
				const st = resizeRef.current;
				if (!st) return;
				const w = clamp(st.w + (e.clientX - st.px), MIN_SIZE, window.innerWidth);
				const h = clamp(st.h + (e.clientY - st.py), MIN_SIZE, window.innerHeight);
				autoFitRef.current = false;
				setSize((p) => (p && p.w === w && p.h === h ? p : { w, h }));
			};
			const onResizeUp = (e) => {
				if (!resizeRef.current) return;
				resizeRef.current = null;
				try {
					e.currentTarget.releasePointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
				persistBox();
			};

			/* 鼠标离开窗口 → 隐藏标题栏/缩放手柄/顶底栏，成为纯视频窗口 */
			const onPanelEnter = () => {
				setIdle(false);
				if (bodyRef.current) bodyRef.current.classList.remove("idle");
			};
			const onPanelLeave = () => {
				setIdle(true);
				if (bodyRef.current) bodyRef.current.classList.add("idle");
			};

			const style = isFs
				? undefined
				: {
						width: eff.w,
						height: eff.h,
						top: pos ? pos.y : 12,
						left: pos ? pos.x : "auto",
						right: pos ? "auto" : 12
					};
			return jsx("div", {
				className: "vdpv-panel" + (idle ? " idle" : ""),
				style,
				ref: panelRef,
				onMouseEnter: onPanelEnter,
				onMouseLeave: onPanelLeave,
				children: [
					jsx("div", {
						className: "vdpv-head",
						onPointerDown: onHeaderPointerDown,
						onPointerMove: onHeaderPointerMove,
						onPointerUp: onHeaderPointerUp,
						onDoubleClick: onHeaderDoubleClick,
						children: [
							jsx("span", { className: "vdpv-title", children: "📺 刷视频" }, "t"),
							jsx("span", { className: "vdpv-sub", ref: titleRef }, "s"),
							jsx("button", {
								type: "button",
								className: "vdpv-hbtn",
								"aria-label": "全屏",
								title: "全屏（F / Esc 退出全屏）",
								onClick: toggleFullscreen,
								children: isFs ? "✕" : "⛶"
							}, "fs"),
							jsx("button", {
								type: "button",
								className: "vdpv-hbtn",
								"aria-label": "关闭",
								title: "关闭（Esc）",
								onClick: onClose,
								children: "✕"
							}, "x")
						]
					}, "head"),
					jsx("div", { ref: bodyRef, className: "vdpv-body" }, "body"),
					jsx(
						"div",
						{
							className: "vdpv-resize",
							title: "拖动调整大小（双击标题栏恢复自动适配）",
							onPointerDown: onResizeDown,
							onPointerMove: onResizeMove,
							onPointerUp: onResizeUp,
							children: "⋱"
						},
						"rz"
					)
				]
			});
		}

		/* ── 侧栏按钮 + 窗口 ── */
		function VideoPlayerControl(props) {
			const useSessions = typeof props.useSessions === "function" ? props.useSessions : () => undefined;
			const useWorkspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces : () => undefined;
			const cwd = useSessions((s) => {
				const c = s && s.current;
				return c && s.byId ? (s.byId[c] && s.byId[c].cwd) || undefined : undefined;
			});
			const recentPath = useWorkspaces((w) => {
				const id = w && w.recentWorkspaceId;
				if (!id || !w.items) return undefined;
				const item = w.items.find((i) => i.workspaceId === id);
				return item ? item.path : undefined;
			});
			const home = cwd || recentPath;
			const [open, setOpen] = useState(false);
			const close = useCallback(() => setOpen(false), []);
			return jsxs(Fragment, {
				children: [
					jsx("button", {
						type: "button",
						className: "vdpv-btn" + (open ? " vdpv-btn-active" : ""),
						"aria-label": "刷视频",
						"aria-pressed": open,
						title: "刷视频（本地文件夹，抖音式）",
						onClick: () => setOpen((v) => !v),
						children: jsx("span", { children: "▶" })
					}, "btn"),
					open ? reactDom.createPortal(jsx(VideoPlayerPanel, { home, onClose: close }, "panel"), document.body) : null
				]
			});
		}

		/* ── 插件体 ── */
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "video-player",
						order: 30,
						label: "刷视频"
					},
					VideoPlayerControl
				)
			);
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});