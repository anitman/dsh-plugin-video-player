/**
 * dsh-plugin-video-player — 宿主半边（node half）。
 *
 * 在 webserver 上注册 `/video-player` 前缀路由，供浏览器半边浏览目录/流式播放视频：
 *   GET /video-player/list?dir=<绝对路径>
 *       -> { ok, dir, parent, dirs, videos }
 *          dirs   = 直接子目录（浏览用）
 *          videos = 递归收集的视频文件（含子目录，上限 2000 / 深 8 层，按文件名排序）
 *   GET /video-player/stream?path=<绝对路径>
 *       -> 200/206 视频字节流（支持 HTTP Range，<video> 快进依赖它）
 *
 * 安全边界（与 dsh-plugin-md-preview 同一本机信任模型）：
 *   - 仅 GET/HEAD；只允许视频扩展名；只允许常规文件；
 *   - 可访问路径 = 本机 shell 可读范围（GUI 默认绑定 127.0.0.1）。
 *
 * SMB:// NAS 支持：
 *   - Windows：\\host\共享\子目录（UNC）由系统 SMB 客户端直读，无需映射盘符；
 *     smb://[user@]host/共享/子目录 自动换算成 UNC 后直读；
 *   - macOS/Linux：共享已挂载（Finder ⌘K / mount_smbfs / mount -t cifs）时
 *     直接填挂载点路径即可；填 smb:// 或 \\UNC 时宿主解析 `mount` 输出
 *     换算成本地挂载路径（凭据由系统挂载时处理，不经过本插件）。
 */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { execFile, execSync } from "node:child_process";
import { homedir } from "node:os";
import { Readable } from "node:stream";

const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const VIDEO_EXTS = new Set([
	".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov", ".mkv",
	".avi", ".flv", ".ts", ".mpg", ".mpeg", ".3gp", ".wmv"
]);
const MIME = {
	".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
	".ogv": "video/ogg", ".ogg": "video/ogg", ".mov": "video/quicktime",
	".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".flv": "video/x-flv",
	".ts": "video/mp2t", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
	".3gp": "video/3gpp", ".wmv": "video/x-ms-wmv"
};
const isVideo = (name) => VIDEO_EXTS.has(extname(name).toLowerCase());
const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });

/* ── SMB / 网络共享路径支持 ──
 * 插件经本机文件系统读文件。
 *   Windows：\\host\共享名\子目录（UNC）由系统 SMB 客户端直接读取，无需映射盘符；
 *            smb://[user@]host/共享名/子目录 换算成 UNC 后直读。
 *   macOS/Linux：SMB 共享挂载在本机（Finder ⌘K / mount_smbfs / mount -t cifs）时
 *            填挂载点路径即可直接浏览/播放；填 smb:// 或 \\UNC 时宿主解析
 *            `mount` 输出找到对应挂载点并换算成本地路径。
 * 凭据不经过本插件——由系统（SMB 客户端 / 挂载）完成认证。 */
const smbHttp = (msg) => Object.assign(new Error(msg), { status: 400 });
// SMB/网络卷断开后常见的读错误码（macOS/Linux + Windows SMB 客户端）
const SMB_GONE_CODES = new Set([
	"EIO", "ESTALE", "ENXIO", "ENETDOWN", "EHOSTDOWN",
	"ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"
]);
const smbGoneMsg = process.platform === "win32"
	? "网络共享不可访问（NAS 可能已离线或共享被断开，请检查连接后重试）"
	: "SMB 挂载不可访问（挂载可能已断开，请重新挂载后再试）";

function parseSmbUrl(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		throw smbHttp("smb:// 地址格式无效");
	}
	// 用户可能输入 percent-encoded 路径，统一解码后比较
	const parts = u.pathname.split("/").filter(Boolean).map((s) => {
		try { return decodeURIComponent(s); } catch { return s; }
	});
	if (!parts.length) throw smbHttp("缺少共享名，格式：smb://host/共享名");
	return { host: (u.hostname || "").toLowerCase(), share: parts[0], sub: parts.slice(1) };
}

/** 从 `mount` 命令输出（macOS 或 Linux 格式）中找 SMB 共享的本地挂载点；找不到返回 null。
 *  macOS:  //user@host/share on /Volumes/Share (smbfs, noowners, ...)
 *  Linux:  //user@host/share on /mnt/share type cifs (ro, ...) */
function findSmbMount(mountText, host, share) {
	let fallback = null;
	for (const line of mountText.split("\n")) {
		if (!/smb|cifs/i.test(line)) continue;
		const mac = line.match(/\bon\s+(.+?)\s+\(smb/i);
		const lin = line.match(/\bon\s+(.+?)\s+type\s+cifs/i);
		const mp = mac ? mac[1].trim() : lin ? lin[1].trim() : null;
		if (!mp) continue;
		const srcParts = line.split(/\s+on\s+/)[0].split("/").filter(Boolean);
		if (srcParts.length < 2) continue;
		let srcShare = srcParts[srcParts.length - 1];
		try { srcShare = decodeURIComponent(srcShare); } catch { /* 保留原样 */ }
		let srcHost = srcParts[0];
		if (srcHost.includes("@")) srcHost = srcHost.slice(srcHost.indexOf("@") + 1);
		// macOS 把中文共享名 URL 编码（空间2 → %E7%A9%BA%E9%97%B42），
		// 同时与挂载点基名（真实目录名）比对作兜底
		const mpBase = (mp.split("/").filter(Boolean).pop() || "");
		let mpBaseDec = mpBase;
		try { mpBaseDec = decodeURIComponent(mpBase); } catch { /* 保留原样 */ }
		if (srcShare !== share && mpBase !== share && mpBaseDec !== share) continue;
		if (host && srcHost && srcHost.toLowerCase() !== host) {
			if (!fallback) fallback = mp; // 同名共享但主机不同：留作兜底
			continue;
		}
		return mp;
	}
	return fallback;
}

/** 纯函数：smb 地址 → 本地挂载路径（mountText 注入，便于测试）。 */
function resolveSmbLocal(url, mountText) {
	const { host, share, sub } = parseSmbUrl(url);
	const mp = findSmbMount(mountText, host, share);
	if (!mp) {
		const shown = host ? `${host}/${share}` : share;
		throw smbHttp(
			`找不到已挂载的 SMB 共享「${shown}」。\n` +
			`请先挂载再使用该地址（也可直接输入挂载后的路径）：\n` +
			`  Finder：⌘K 连接服务器 → smb://${shown}\n` +
			`  终端：mount_smbfs //${shown} /Volumes/${share}`
		);
	}
	return sub.length ? join(mp, ...sub) : mp;
}

let mountCache = { at: 0, text: "" };
function getMountText() {
	const now = Date.now();
	if (now - mountCache.at > 5000) {
		try {
			mountCache = { at: now, text: execSync("mount", { timeout: 3000, encoding: "utf8" }) };
		} catch {
			mountCache = { at: now, text: "" };
		}
	}
	return mountCache.text;
}

/** smb://[user@]host/共享名/子目录 → \\host\共享名\子目录（Windows 系统 SMB 客户端直读）。 */
function smbUrlToUnc(url) {
	const { host, share, sub } = parseSmbUrl(url);
	const segs = [host, share, ...sub];
	return "\\\\" + segs.filter(Boolean).map((s) => String(s).replace(/\//g, "\\")).join("\\");
}

/** 归一化 UNC 输入：保留开头的 \\\\，合并路径中多余反斜杠、去掉结尾反斜杠
 *  （\\\\host\\share\ → \\\\host\share；\\\\Kenny_cloud\video\子目录 原样可用）。 */
function normalizeUnc(unc) {
	const noTail = unc.replace(/\\+$/, "");
	if (!/^\\\\/.test(noTail)) return noTail;
	return "\\\\" + noTail.slice(2).replace(/\\{2,}/g, "\\");
}

/** 解析输入路径，其余原样透传（错误带 status）：
 *  - Windows：smb:// 换算成 UNC；\\UNC 归一化后由系统 SMB 客户端直读；
 *  - macOS/Linux：smb:// 与 \\UNC 解析 `mount` 输出换算成本地挂载路径。 */
function resolveLocalPath(input) {
	const raw = (input || "").trim();
	if (/^smb:\/\//i.test(raw)) {
		if (process.platform === "win32") return smbUrlToUnc(raw);
		return resolveSmbLocal(raw, getMountText());
	}
	if (/^\\\\/.test(raw)) {
		if (process.platform === "win32") return normalizeUnc(raw);
		return resolveSmbLocal("smb:" + raw.replace(/\\/g, "/"), getMountText());
	}
	return raw;
}

/* ── yt-dlp 在线视频（网址列表 + 代理直播） ──
 * 面板地址栏可粘贴 yt-dlp 支持的视频/播放列表网址（bilibili、YouTube 等）：
 *   - list：yt-dlp --flat-playlist 拉取列表（内存缓存 30 分钟）；
 *   - stream：单文件渐进流由宿主代理转发（补 UA/Referer/Cookie，Range 透传）；
 *     DASH/HLS 分段流（bilibili 全 DASH）自动 yt-dlp 下载合并为本地 mp4（≤1080p，
 *     需 ffmpeg），之后本地 Range 流播放，同一视频只下一次。
 * cookies.txt 存于 ~/.dsh/video-player/cookies/，供高清/登录态使用；
 * 本机配置 ~/.dsh/video-player/config.json（"ytdlp"/"ffmpeg" 路径，不入库）。 */
const COOKIE_DIR = join(homedir(), ".dsh", "video-player", "cookies");
const COOKIE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REMOTE_TTL = 30 * 60 * 1000;
const remoteCache = new Map();
const directCache = new Map();
const directFailCache = new Map(); // 无直连流的 watch → 时间戳（10 分钟内不再尝试 yt-dlp 解析）
const DIRECT_FAIL_TTL = 10 * 60 * 1000;

async function cookiePath(name) {
	if (!COOKIE_NAME_RE.test(name || "")) throw Object.assign(new Error("invalid cookie name"), { status: 400 });
	return join(COOKIE_DIR, name + ".txt");
}
async function listCookies() {
	try {
		const entries = await readdir(COOKIE_DIR, { withFileTypes: true });
		const out = [];
		for (const e of entries) {
			if (!e.isFile() || !e.name.endsWith(".txt")) continue;
			const st = await stat(join(COOKIE_DIR, e.name));
			out.push({ name: e.name.slice(0, -4), size: st.size, mtime: st.mtimeMs });
		}
		out.sort((a, b) => b.mtime - a.mtime);
		return out;
	} catch {
		return [];
	}
}
async function readCookieHeader(name, host) {
	try {
		const text = await readFile(await cookiePath(name), "utf8");
		return parseCookiesHeader(text, host);
	} catch {
		return "";
	}
}
/** Netscape cookies.txt → "k=v; k=v"（只取未过期、且域匹配 host 的条目；
 * 浏览器整站导出的 cookies.txt 常含大量无关域，全发会超 CDN 头大小限制）。 */
function parseCookiesHeader(text, host) {
	const now = Math.floor(Date.now() / 1000);
	const pairs = [];
	let h = String(host || "").toLowerCase();
	for (const line of String(text).split(/\r?\n/)) {
		if (!line || line.startsWith("#")) continue;
		const f = line.split("\t");
		if (f.length < 7) continue;
		const exp = Number(f[4]);
		if (exp && exp < now) continue;
		if (h) {
			const d = String(f[0] || "").toLowerCase().replace(/^\./, "");
			if (d && !(h === d || h.endsWith("." + d))) continue;
		}
		pairs.push(f[5] + "=" + f[6]);
	}
	return pairs.join("; ");
}
async function saveCookie(name, text) {
	if (!COOKIE_NAME_RE.test(name || "")) throw Object.assign(new Error("invalid cookie name"), { status: 400 });
	if (typeof text !== "string" || !text.length) throw Object.assign(new Error("empty cookie file"), { status: 400 });
	if (text.length > 5 * 1024 * 1024) throw Object.assign(new Error("cookie file too large"), { status: 400 });
	await mkdir(COOKIE_DIR, { recursive: true });
	await writeFile(await cookiePath(name), text, "utf8");
}
async function deleteCookie(name) {
	await unlink(await cookiePath(name)).catch(() => {});
}

/* yt-dlp 定位与执行：本机配置（~/.dsh/video-player/config.json 的 "ytdlp" 字段）
 * > DVP_YTDLP 环境变量 > PATH（yt-dlp / yt-dlp.exe）> python -m yt_dlp。
 * 机器特定路径只放在本机配置里，仓库代码不包含任何人的本地环境。 */
const LOCAL_CONFIG = join(homedir(), ".dsh", "video-player", "config.json");
async function ytdlpCandidates() {
	const out = [];
	try {
		const c = JSON.parse(await readFile(LOCAL_CONFIG, "utf8"));
		if (typeof c.ytdlp === "string" && c.ytdlp.trim()) out.push({ cmd: c.ytdlp.trim(), args: [] });
	} catch {
		/* 无本机配置则跳过 */
	}
	if (process.env.DVP_YTDLP) out.push({ cmd: process.env.DVP_YTDLP, args: [] });
	out.push({ cmd: "yt-dlp", args: [] });
	if (process.platform === "win32") out.push({ cmd: "yt-dlp.exe", args: [] });
	out.push({ cmd: process.platform === "win32" ? "python" : "python3", args: ["-m", "yt_dlp"] });
	return out;
}
let ytdlpCmdPromise = null;
function ytdlpExec(cmd, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				const msg = String(stderr || err.message || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
				reject(Object.assign(new Error(msg || "yt-dlp failed"), { status: 502 }));
			} else resolve(stdout);
		});
	});
}
function ytdlpCmd() {
	if (!ytdlpCmdPromise) {
		ytdlpCmdPromise = (async () => {
			for (const c of await ytdlpCandidates()) {
				try {
					await ytdlpExec(c.cmd, [...c.args, "--version"], 8000);
					return c;
				} catch {
					/* 试下一个 */
				}
			}
			throw Object.assign(new Error("找不到 yt-dlp：请安装后加入 PATH，或设 DVP_YTDLP 环境变量，或在 " + LOCAL_CONFIG + " 配置 {\"ytdlp\":\"<yt-dlp 可执行路径>\"}"), { status: 500 });
		})();
	}
	return ytdlpCmdPromise;
}
let ffmpegLocPromise = null;
function ffmpegLocation() {
	if (!ffmpegLocPromise) {
		ffmpegLocPromise = (async () => {
			try {
				const c = JSON.parse(await readFile(LOCAL_CONFIG, "utf8"));
				if (typeof c.ffmpeg === "string" && c.ffmpeg.trim()) return c.ffmpeg.trim();
			} catch {
				/* 无本机配置 → 依赖 PATH */
			}
			return "";
		})();
	}
	return ffmpegLocPromise;
}
async function runYtdlp(args, timeoutMs) {
	const c = await ytdlpCmd();
	const ff = await ffmpegLocation();
	/* 浏览器 UA：bilibili 等站对 yt-dlp 默认 UA 有 352/412 风控 */
	return ytdlpExec(c.cmd, [...c.args, ...(ff ? ["--ffmpeg-location", ff] : []), "--user-agent", UA, ...args], timeoutMs);
}

/** yt-dlp JSON 抽取：先不带 cookie，失败且选了 cookie 时带 cookie 重试。
 * （整浏览器导出的 cookies.txt 含跨站会话 cookie，直接带上前端站点会风控。） */
async function extractJson(args, cookieName, timeoutMs) {
	try {
		return JSON.parse(await runYtdlp(args, timeoutMs));
	} catch (e) {
		if (!cookieName) throw e;
		const p = await cookiePath(cookieName).catch(() => null);
		if (!p) throw e;
		return JSON.parse(await runYtdlp([...args, "--cookies", p], timeoutMs));
	}
}

/** YouTube 风控类错误 → 截断并附中文提示 */
function hintYt(msg) {
	const t = String(msg || "");
	if (/not a bot|Sign in to confirm/i.test(t)) {
		return t.split("
")[0].slice(0, 120) + "；（YouTube 正在风控当前网络/IP：稍后重试；或用已登录 YouTube 的浏览器重新导出该站 cookies.txt，在 🍪 行上传后再试）";
	}
	return t;
}

/* 远程列表：网址 → yt-dlp flat-playlist → 与本地目录同构的 videos 数组 */
function isRemoteDir(raw) {
	return /^https?:\/\//i.test(raw) || /^(bilibili|youtube|twitter|x|vimeo|tiktok):/i.test(raw);
}
function makeYtPath(entry, listUrl) {
	const id = entry.id || "";
	let watch = entry.url || entry.webpage_url || "";
	if (!/^https?:\/\//i.test(watch)) {
		if (/(bilibili\.com)/i.test(listUrl) && /^BV/i.test(id)) watch = "https://www.bilibili.com/video/" + id;
		else watch = listUrl;
	}
	return "yt|" + watch + "|" + listUrl;
}
function parseYtPath(p) {
	const i = p.indexOf("|", 3);
	if (i < 0) return null;
	return { watch: p.slice(3, i), list: p.slice(i + 1) };
}
async function handleRemoteList(rawDir, cookieName, res) {
	const key = rawDir + "\u0000" + (cookieName || "");
	const now = Date.now();
	const hit = remoteCache.get(key);
	if (hit && now - hit.at < REMOTE_TTL) return json(res, 200, { ok: true, ...hit.data });
	const args = ["-J", "--flat-playlist", "--no-warnings", "--ignore-config", rawDir];
	let data;
	try {
		data = await extractJson(args, cookieName, 45000);
	} catch (e) {
		return json(res, 502, { ok: false, error: "yt-dlp 获取列表失败：" + hintYt(e.message) });
	}
	const entries = Array.isArray(data.entries) ? data.entries : [data];
	const videos = entries.filter((e) => e && (e.id || e.url)).slice(0, MAX_FILES).map((e) => ({
		name: e.title || e.id || e.url,
		path: makeYtPath(e, rawDir)
	}));
	if (!videos.length) return json(res, 400, { ok: false, error: "未解析到视频（网址可能不是视频/播放列表页）" });
	const out = { dir: rawDir, parent: null, dirs: [], videos };
	remoteCache.set(key, { at: now, data: out });
	return json(res, 200, { ok: true, ...out });
}

/* 直连地址解析 + 代理转发（Range 透传；403/404/410 刷新地址重试一次） */
/** 直连地址解析：先匿名（避免陈旧 cookie 触发风控），失败再带 cookie 重试。 */
async function resolveDirectUrl(watch, cookieName) {
	try {
		return await resolveDirectUrlOnce(watch, null);
	} catch (e) {
		if (!cookieName) throw e;
		return resolveDirectUrlOnce(watch, cookieName);
	}
}
async function resolveDirectUrlOnce(watch, cookieName) {
	const key = watch + "\u0000" + (cookieName || "");
	const hit = directCache.get(key);
	if (hit && Date.now() - hit.at < REMOTE_TTL) return hit.url;
	/* 负缓存：该地址无单文件直连流 → 跳过 yt-dlp 解析，直接走缓存下载 */
	const failAt = directFailCache.get(key);
	if (failAt && Date.now() - failAt < DIRECT_FAIL_TTL) throw Object.assign(new Error("无直连流（负缓存）"), { status: 501 });
	/* 网址本身即视频文件直链 → 直接返回（泛型 CDN 支持 Range） */
	if (/\.(mp4|webm|m4v|mov|ogv|mkv)(\?|$)/i.test(watch)) {
		directCache.set(key, { at: Date.now(), url: watch });
		return watch;
	}
	let cookieArg = [];
	if (cookieName) {
		try { cookieArg = ["--cookies", await cookiePath(cookieName)]; } catch { cookieArg = []; }
	}
	/* 三级回退：单文件 MP4 优先；取不到再最佳格式；多P/合集用 --playlist-items 1 */
	const common = ["--no-warnings", "--ignore-config", ...cookieArg];
	const attempts = [
		["--get-url", "-f", "b[ext=mp4][acodec!=none]/b[ext=webm][acodec!=none]/b[ext=m4v][acodec!=none]", "--no-playlist", ...common, watch],
		["--get-url", "-f", "b", "--no-playlist", ...common, watch],
		["--get-url", "-f", "b", "--playlist-items", "1", ...common, watch]
	];
	let url = "";
	let lastErr = "";
	for (const args of attempts) {
		try {
			url = (await runYtdlp(args, 45000)).trim();
			if (/^https?:\/\//i.test(url)) break;
			url = "";
		} catch (e) {
			lastErr = String(e.message || "");
			url = "";
		}
	}
	if (!url) {
		/* “格式不可用”= 该站没有单文件流（bilibili 全 DASH）→ 负缓存 10 分钟 */
		if (/not available|no video/i.test(lastErr)) directFailCache.set(key, Date.now());
		throw Object.assign(new Error("yt-dlp 未能解析出可播放地址" + (lastErr ? "：" + lastErr.slice(0, 120) : "")), { status: 502 });
	}
	if (/\.(m3u8|mpd|m4s)(\?|$)/i.test(url)) {
		directFailCache.set(key, Date.now());
		throw Object.assign(new Error("该视频只有 HLS/DASH 分段流，暂不支持在线直播（可先用 yt-dlp 下载到本地文件夹再播放）"), { status: 501 });
	}
	directCache.set(key, { at: Date.now(), url });
	return url;
}
async function handleYtStream(ytPath, cookieName, req, res) {
	const parsed = parseYtPath(ytPath);
	if (!parsed) return json(res, 400, { ok: false, error: "bad yt path" });
	let cookieHdr = "";
	let watchHost = "";
	try { watchHost = new URL(parsed.watch).hostname; } catch { watchHost = ""; }
	try { cookieHdr = cookieName ? await readCookieHeader(cookieName, watchHost) : ""; } catch { cookieHdr = ""; }
	const key = parsed.watch + "\u0000" + (cookieName || "");
	/* 已缓存 → 直接本地 Range 流（秒开，不再请求在线源） */
	if (existsSync(cacheTarget(parsed.watch, cookieName).target)) {
		return streamLocalFile(cacheTarget(parsed.watch, cookieName).target, req, res);
	}
	let upstream = null;
	for (let attempt = 0; attempt < 2 && !upstream; attempt++) {
		let direct;
		try {
			direct = await resolveDirectUrl(parsed.watch, cookieName);
		} catch (e) {
			if (attempt === 1) return streamCachedVideo(parsed.watch, cookieName, req, res);
			directCache.delete(key);
			continue;
		}
		const headers = { "user-agent": UA };
		try { headers.referer = new URL(parsed.watch).origin; } catch { /* ignore */ }
		if (cookieHdr) headers.cookie = cookieHdr;
		const range = req.headers.range;
		if (range) headers.range = range;
		try {
			upstream = await fetch(direct, { headers, redirect: "follow" });
		} catch (e) {
			directCache.delete(key);
			if (attempt === 1) return json(res, 502, { ok: false, error: "连接视频源失败：" + e.message });
			continue;
		}
		if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
			Promise.resolve(upstream.body.cancel()).catch(() => {});
			upstream = null;
			directCache.delete(key);
		}
	}
	if (!upstream) return streamCachedVideo(parsed.watch, cookieName, req, res);
	const headers = { "cache-control": "no-store" };
	for (const k of ["content-type", "content-length", "content-range"]) {
		const v = upstream.headers.get(k);
		if (v) headers[k] = v;
	}
	headers["accept-ranges"] = "bytes";
	res.writeHead(upstream.status, headers);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const body = Readable.fromWeb(upstream.body);
	req.on("close", () => {
		try { body.destroy(); } catch { /* ignore */ }
		/* cancel() 在已锁定的流上会异步 reject，必须吞掉，否则未处理 rejection 会崩进程 */
		Promise.resolve(upstream.body.cancel()).catch(() => {});
	});
	body.pipe(res);
}

/* 缓存下载模式：DASH/HLS 等无法单文件直连的流（bilibili 全 DASH）→ yt-dlp 下载合并
 * 为本地 mp4（≤1080p，同一视频只下一次，并发单飞），之后走本地 Range 流播放。
 * 需要 ffmpeg（PATH 或本机 config.json 的 "ffmpeg" 字段）。 */
const CACHE_DIR = join(homedir(), ".dsh", "video-player", "cache");
const CACHE_MAXH = 1080;
const dlJobs = new Map();
function djb2(str) {
	let h = 5381;
	for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
	return h.toString(36);
}
function cacheTarget(watch, cookieName) {
	let host = "misc";
	try { host = new URL(watch).hostname.replace(/[^a-z0-9.-]/gi, "_"); } catch { /* misc */ }
	const id = djb2(watch + "|" + (cookieName || ""));
	const dir = join(CACHE_DIR, host);
	return { dir, id, target: join(dir, id + ".mp4") };
}
async function downloadToCache(watch, cookieName) {
	const { dir, id, target } = cacheTarget(watch, cookieName);
	if (existsSync(target)) return target;
	const jobKey = dir + "/" + id;
	const doing = dlJobs.get(jobKey);
	if (doing) return doing;
	const job = (async () => {
		await mkdir(dir, { recursive: true });
		let cookieArg = [];
		if (cookieName) {
			try { cookieArg = ["--cookies", await cookiePath(cookieName)]; } catch { cookieArg = []; }
		}
		const rest = [
			"-f", "b[height<=" + CACHE_MAXH + "]/bv*[height<=" + CACHE_MAXH + "]+ba/b",
			"--merge-output-format", "mp4",
			"--no-playlist", "--no-warnings", "--ignore-config",
			"-o", join(dir, id + ".%(ext)s"),
			watch
		];
		try {
			await runYtdlp(rest, 15 * 60 * 1000);
		} catch (e) {
			if (!cookieArg.length) throw e;
			await runYtdlp([...rest, ...cookieArg], 15 * 60 * 1000); // 匿名失败 → 带 cookie 重试
		}
		if (!existsSync(target)) {
			/* 扩展名不一致（如 webm 源未合并）→ 按 id 前缀查找 */
			const found = (await readdir(dir)).find((n) => n.startsWith(id + "."));
			if (!found) throw Object.assign(new Error("下载完成但未找到输出文件"), { status: 502 });
			return join(dir, found);
		}
		return target;
	})().finally(() => dlJobs.delete(jobKey));
	dlJobs.set(jobKey, job);
	return job;
}
async function streamCachedVideo(watch, cookieName, req, res) {
	let file;
	try {
		file = await downloadToCache(watch, cookieName);
	} catch (e) {
		return json(res, e.status || 502, { ok: false, error: "在线视频下载失败（DASH/HLS 转本地缓存播放）：" + hintYt(e.message).slice(0, 300) });
	}
	return streamLocalFile(file, req, res);
}

/** 本地文件 Range 流（200/206/416 + SMB 断连提示）——本地目录与在线缓存共用。 */
function streamLocalFile(p, req, res) {
	stat(p).then((st) => {
		if (!st.isFile()) {
			throw Object.assign(new Error("not a regular file"), { status: 400 });
		}
		const size = st.size;
		const type = MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
		let start = 0;
		let end = size - 1;
		let code = 200;
		const range = req.headers.range;
		if (range) {
			const m = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!m) {
				throw Object.assign(new Error("invalid range"), { status: 416, size });
			}
			if (m[1] === "" && m[2] !== "") {
				start = Math.max(0, size - Number(m[2]));
			} else {
				start = Number(m[1] || "0");
				end = m[2] === "" ? size - 1 : Number(m[2]);
			}
			if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
				throw Object.assign(new Error("invalid range"), { status: 416, size });
			}
			end = Math.min(end, size - 1);
			code = 206;
		}
		const headers = {
			"content-type": type,
			"content-length": String(end - start + 1),
			"accept-ranges": "bytes",
			"cache-control": "no-store"
		};
		if (code === 206) {
			headers["content-range"] = "bytes " + start + "-" + end + "/" + size;
		}
		res.writeHead(code, headers);
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(p, { start, end }).pipe(res);
	}).catch((error) => {
		if (res.headersSent) {
			res.end();
			return;
		}
		if (error && error.code && SMB_GONE_CODES.has(error.code)) {
			return json(res, 500, { ok: false, error: "读取失败（" + smbGoneMsg + "）" });
		}
		const status = error && error.status ? error.status : error && error.code === "ENOENT" ? 404 : 500;
		if (status === 416) {
			res.writeHead(416, { "content-range": "bytes */" + (error && error.size ? error.size : 0) });
			res.end();
			return;
		}
		json(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
	});
}

/* cookies 管理端点：GET 列表 / POST 上传 / DELETE 删除 */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				reject(Object.assign(new Error("body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
async function handleCookies(req, url, res) {
	try {
		if (req.method === "GET") return json(res, 200, { ok: true, cookies: await listCookies() });
		if (req.method === "DELETE") {
			const name = queryParam(url, "name");
			if (!name) return json(res, 400, { ok: false, error: "missing ?name=" });
			await deleteCookie(name);
			return json(res, 200, { ok: true });
		}
		const body = JSON.parse(await readBody(req, 5 * 1024 * 1024));
		await saveCookie(String(body.name || ""), String(body.data || ""));
		return json(res, 200, { ok: true, name: body.name });
	} catch (e) {
		return json(res, e.status || 500, { ok: false, error: e.message || String(e) });
	}
}

function json(res, code, body) {
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(JSON.stringify(body));
}

function queryParam(url, key) {
	const raw = url.searchParams.get(key);
	try {
		return raw === null ? "" : decodeURIComponent(raw);
	} catch {
		return "";
	}
}

/** 递归收集视频文件（数量/深度上限保护），跳过不可读条目。 */
async function collectVideos(dir, depth, acc) {
	if (acc.length >= MAX_FILES || depth > MAX_DEPTH) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (acc.length >= MAX_FILES) break;
		const full = join(dir, e.name);
		try {
			if (e.isDirectory()) {
				await collectVideos(full, depth + 1, acc);
			} else if (e.isFile() && isVideo(e.name)) {
				const st = await stat(full);
				acc.push({ name: e.name, path: full, size: st.size, mtimeMs: st.mtimeMs });
			}
		} catch {
			/* 跳过无法读取的条目 */
		}
	}
}

/** GET /video-player/list?dir= — 目录浏览 + 递归视频清单。 */
async function handleList(url, res) {
	const rawDir = queryParam(url, "dir");
	if (!rawDir) return json(res, 400, { ok: false, error: "missing ?dir=" });
	if (isRemoteDir(rawDir)) return handleRemoteList(rawDir, queryParam(url, "cookie"), res);
	let dir;
	try {
		dir = resolveLocalPath(rawDir);
	} catch (e) {
		return json(res, e.status || 400, { ok: false, error: e.message });
	}
	let st;
	try {
		st = await stat(dir);
	} catch (err) {
		if (err && SMB_GONE_CODES.has(err.code))
			return json(res, 500, { ok: false, error: "目录不可访问（" + smbGoneMsg + "）" });
		return json(res, 404, { ok: false, error: "directory not found" });
	}
	if (!st.isDirectory()) return json(res, 400, { ok: false, error: "not a directory" });
	const base = dir.replace(/[\\/]+$/, "");
	const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
	const dirs = [];
	for (const e of entries) {
		if (e.isDirectory()) dirs.push({ name: e.name, path: join(base, e.name) });
	}
	dirs.sort(byName);
	const videos = [];
	await collectVideos(base, 0, videos);
	videos.sort(byName);
	return json(res, 200, { ok: true, dir: base, parent: dirname(base), dirs, videos });
}

/** GET /video-player/stream?path= — 视频字节流，支持 Range（206）。 */
function handleStream(url, req, res) {
	const rawP = queryParam(url, "path");
	if (!rawP) {
		json(res, 400, { ok: false, error: "missing ?path=" });
		return;
	}
	if (rawP.startsWith("yt|")) return handleYtStream(rawP, queryParam(url, "cookie"), req, res);
	let p;
	try {
		p = resolveLocalPath(rawP);
	} catch (e) {
		json(res, e.status || 400, { ok: false, error: e.message });
		return;
	}
	if (!isVideo(basename(p))) {
		json(res, 400, { ok: false, error: "not a video file" });
		return;
	}
	streamLocalFile(p, req, res);
}

/**
 * 宿主插件体：挂载 `/video-player` 前缀路由，fiber 卸载时自动摘除。
 * @param ctx - 宿主 context（注入 webServer 服务）。
 */
function apply(ctx) {
	const dispose = ctx.webServer.register({
		kind: "prefix",
		path: "/video-player",
		handler: (req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			const isCookies = url.pathname === "/video-player/cookies";
			const okMethods = isCookies ? ["GET", "POST", "DELETE"] : ["GET", "HEAD"];
			if (!okMethods.includes(req.method)) {
				return json(res, 405, { ok: false, error: "method not allowed" });
			}
			if (url.pathname === "/video-player/list") return handleList(url, res);
			if (url.pathname === "/video-player/stream") return handleStream(url, req, res);
			if (isCookies) return handleCookies(req, url, res);
			return json(res, 404, { ok: false, error: "unknown endpoint" });
		}
	});
	ctx.effect(() => dispose, "video-player: host routes");
}
const inject = ["webServer"];

/* 仅供测试：SMB 地址解析的纯函数。 */
const _test = { parseSmbUrl, findSmbMount, resolveSmbLocal, smbUrlToUnc, normalizeUnc, parseCookiesHeader, makeYtPath, isRemoteDir, parseYtPath };

export { apply, inject, _test };