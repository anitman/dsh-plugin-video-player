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
 *   - 共享已挂载（Finder ⌘K / mount_smbfs）时，直接填挂载点路径即可；
 *   - 也可直接填 smb://host/共享/子目录 或 \\host\共享\子目录，
 *     宿主解析 `mount` 输出换算成本地挂载路径（凭据由系统挂载时处理，不经过本插件）。
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { execSync } from "node:child_process";

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

/* ── SMB:// NAS 路径支持 ──
 * 插件经本机文件系统读文件：SMB 共享只要挂载在本机（Finder ⌘K / mount_smbfs），
 * 填挂载点路径即可直接浏览/播放。额外支持直接填
 *   smb://[user@]host/共享名/子目录  或  \\host\共享名\子目录
 * 宿主解析 `mount` 输出找到对应挂载点并换算成本地路径。
 * 凭据不经过本插件——挂载时由系统（Finder/mount_smbfs）完成认证。 */
const smbHttp = (msg) => Object.assign(new Error(msg), { status: 400 });
// SMB/网络卷断开后常见的读错误码
const SMB_GONE_CODES = new Set(["EIO", "ESTALE", "ENXIO", "ENETDOWN", "EHOSTDOWN"]);

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

/** 解析输入路径：smb:// 与 \\UNC 换算成本地挂载路径，其余原样透传（错误带 status）。 */
function resolveLocalPath(input) {
	const raw = (input || "").trim();
	if (/^smb:\/\//i.test(raw)) return resolveSmbLocal(raw, getMountText());
	if (/^\\\\/.test(raw)) return resolveSmbLocal("smb:" + raw.replace(/\\/g, "/"), getMountText());
	return raw;
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
			return json(res, 500, { ok: false, error: "目录不可访问（SMB 挂载可能已断开，请重新挂载后再试）" });
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
			return json(res, 500, { ok: false, error: "读取失败（SMB 挂载可能已断开，请重新挂载后再试）" });
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
			if (req.method !== "GET" && req.method !== "HEAD") {
				return json(res, 405, { ok: false, error: "method not allowed" });
			}
			if (url.pathname === "/video-player/list") return handleList(url, res);
			if (url.pathname === "/video-player/stream") return handleStream(url, req, res);
			return json(res, 404, { ok: false, error: "unknown endpoint" });
		}
	});
	ctx.effect(() => dispose, "video-player: host routes");
}
const inject = ["webServer"];

/* 仅供测试：SMB 地址解析的纯函数。 */
const _test = { parseSmbUrl, findSmbMount, resolveSmbLocal };

export { apply, inject, _test };