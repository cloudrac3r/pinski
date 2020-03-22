//@ts-check

const fs = require("fs")
const http = require("http")
const path = require("path")
const mime = require("mime")
const cf = require("./util/common.js")
const pug = require("pug")
const sass = require("node-sass")
const watchAndCompile = require("./util/watch_compiler.js")
const WebSocket = require("ws")
const stream = require("stream")
const crypto = require("crypto")

const symbols = {
	PUG_SOURCE_NOT_FOUND: Symbol("PUG_SOURCE_NOT_FOUND")
}

/**
 * @typedef {Map<string, {web: (locals?) => any, client: (locals?) => any}>} PugCache
 */

/**
 * @typedef Config
 * @property {number} [port]
 * @property {string} [filesDir]
 * @property {any} [globalHeaders]
 * @property {any} [basicCacheControl]
 * @property {string} [ip]
 * @property {string} [relativeRoot]
 * @property {boolean} [ws]
 */

void 0

/** @type {Config} */
const defaultConfig = {
	port: 8080,
	filesDir: "html",
	globalHeaders: {},
	basicCacheControl: {
		exts: [
			"ttf", "svg", "gif", "webmanifest", "ico",
			"png", "jpg", "jpeg",
			"PNG", "JPG", "JPEG"
		],
		seconds: 604800
	},
	ip: "0.0.0.0",
	relativeRoot: "",
	ws: false
}

function mimeType(type) {
	const types = new Map([
		["mjs", "text/javascript"],
		["ttf", "application/font-sfnt"],
		["ico", "image/x-icon"],
		["sass", "text/css"]
	])
	return types[type.split(".")[1]] || mime.getType(type)
}

function toRange(length, headers, req) {
	if (length === 0) return {statusCode: 200, start: undefined, end: undefined, length: 0}
	let start = 0
	let end = length-1
	let statusCode = 200
	if (req.headers.range) {
		let match = req.headers.range.match(/^bytes=([0-9]*)-([0-9]*)$/)
		if (match) {
			if (match[1]) {
				let value = +match[1]
				if (!isNaN(value) && value >= start) {
					start = value
					statusCode = 206
				}
			}
			if (match[2]) {
				let value = +match[2]
				if (!isNaN(value) && value <= end) {
					end = value
					statusCode = 206
				}
			}
		}
	}
	if (start > end) {
		start = 0
		end = length-1
		statusCode = 200
	}
	if (statusCode == 206) {
		headers["Accept-Ranges"] = "bytes"
		headers["Content-Range"] = "bytes "+start+"-"+end+"/"+length
	}
	return {statusCode, start, end, length: end - start + 1}
}

class Pinski {
	/**
	 * @param {Config} config
	 */
	constructor(config) {
		this.config = defaultConfig
		Object.assign(this.config, config)
		this.pugCache = new Map()
		this.sassCache = new Map()
		/** @type {Map<string, {hash: string, type: string}>} */
		this.staticFileTable = new Map()

		this.mutedLogs = []

		this.api = {
			handlers: [],
			routeStore: new Map(),
			cancelStore: new Map(),
			dirs: []
		}
		/** pug/sass */
		this.pageHandlers = []
		this.notFoundTarget = null

		this.wss = null
		this.server = null
	}

	getExports() {
		return {
			instance: this,
			server: this.server,
			wss: this.wss,
			pugCache: this.pugCache,
			sassCache: this.sassCache,
			staticFileTable: this.staticFileTable
		}
	}

	addRoute(web, local, type = undefined, absolute = false) {
		this.deleteRoute(web)
		this.pageHandlers.push({web, local, type, absolute})
	}

	deleteRoute(web) {
		this.pageHandlers = this.pageHandlers.filter(p => p.web !== web)
	}

	enableWS() {
		this.wss = new WebSocket.Server({server: this.server})
	}

	startServer() {
		this.server = http.createServer(this._handleRequest.bind(this)).listen(this.config.port, this.config.ip)
	}

	muteLogsStartingWith(string) {
		this.mutedLogs.push(string)
	}

	setNotFoundTarget(target) {
		this.notFoundTarget = target
	}

	_shouldLog(path) {
		return !this.mutedLogs.some(muted => path.startsWith(muted))
	}

	addStaticHashTableDir(dir) {
		watchAndCompile(dir, [], this.staticFileTable, fullPath => {
			return new Promise((resolve, reject) => {
				const hash = crypto.createHash("sha256")
				stream.pipeline(
					fs.createReadStream(fullPath),
					hash,
					err => {
						if (err) return reject(err)
						const digest = hash.digest("hex")
						console.log(fullPath, "→", digest)
						return resolve({hash: digest, type: "static"})
					}
				)
			})
		})
	}

	addPugDir(dir, includes = []) {
		watchAndCompile(dir, includes, this.pugCache, fullPath => {
			try {
				const web = pug.compileFile(fullPath, {doctype: "html"})
				const client = pug.compileFileClient(fullPath, {doctype: "html", compileDebug: false})
				return {web, client}
			} catch (error) {
				console.error(`Pug compilation of file ${fullPath} failed.`)
				console.error(error.message)
				return null
			}
		})
	}

	addSassDir(dir) {
		watchAndCompile(dir, [], this.sassCache, fullPath =>
			fs.promises.readFile(fullPath, {encoding: "utf8"}).then(data => {
				if (data) {
					try {
						const rendered = sass.renderSync({data, indentedSyntax: true}).css.toString()
						const hash = crypto.createHash("sha256").update(rendered).digest("hex")
						this.staticFileTable.set(fullPath, {type: "sass", hash})
						console.log(fullPath, "→", hash)
						return rendered
					} catch (error) {
						console.error(`Sass compilation of file ${fullPath} failed.`)
						console.error(error)
						return null
					}
				} else {
					return null
				}
			})
		)
	}

	addAPIDir(dir) {
		return this.addAbsoluteAPIDir(path.join(this.config.relativeRoot, dir))
	}

	addAbsoluteAPIDir(dir) {
		if (this.api.dirs.includes(dir)) return
		this.api.dirs.push(dir)
		watchAndCompile(dir, [], new Map(), async fullPath => {
			if (this.api.cancelStore.has(fullPath)) {
				const cancel = this.api.cancelStore.get(fullPath)
				this.api.cancelStore.delete(fullPath)
				cancel()
			}
			delete require.cache[require.resolve(fullPath)]
			let routes = require(fullPath)
			if (routes instanceof Array) {
				routes = routes.filter(r => {
					if (r.cancel) {
						this.api.cancelStore.set(fullPath, r.code)
						return false
					} else {
						return true
					}
				})
				//console.log("Adding new handers", routes)
				this.api.routeStore.set(fullPath, routes)
				this.api.handlers = [].concat(...this.api.routeStore.values())
			}
		})
	}

	_handleRequest(req, res) {
		// change HEAD to GET
		let isHead = req.method === "HEAD"
		if (isHead) req.method = "GET"
		// fill host
		if (!req.headers.host) req.headers.host = "localhost"
		// headers can be added to later
		let headers = {}
		// parse url
		let url
		try {
			url = new URL(req.url, "http://localhost")
		} catch (e) {
			res.writeHead(400, {"Content-Type": "text/plain; charset=UTF-8"})
			res.end("Malformed URI")
			return
		}
		// remove trailing slash
		if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "")
		if (this._shouldLog(url.pathname)) cf.log(`[INC] ${url.pathname}`, "spam")
		// manage cache control for file extension
		let ext = url.pathname.split(".").slice(-1)[0]
		if (this.config.basicCacheControl.exts.includes(ext)) headers["Cache-Control"] = `max-age=${this.config.basicCacheControl.seconds}, public`
		// go through handlers
		try {
			this._handleWithAPI(req, res, url, headers, isHead)
			|| this._handleWithPage(req, res, url, headers, isHead)
			|| this._handleDirect(req, res, url, headers, isHead)
		} catch (err) {
			this._handleError(req, res, url, headers, isHead, err)
		}
	}

	/**
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 * @param {URL} url
	 */
	_handleWithAPI(req, res, url, headers, isHead) {
		let i = 0
		let handled = false
		// try each handler
		while (!handled && i < this.api.handlers.length) {
			// prepare while loop for next
			const handler = this.api.handlers[i]
			i++
			// see if it works
			if (!handler.route || !handler.methods || !handler.methods.includes(req.method)) continue
			const re = new RegExp(`^${handler.route}$`)
			const match = url.pathname.match(re)
			if (!match) continue
			// it works. don't loop any more
			handled = true
			// process the request
			if (this._shouldLog(url.pathname)) cf.log(`[API] ${url.pathname} = ${handler.route}`, "spam")
			new Promise((resolve, reject) => {
				const fill = match.slice(1)
				if (handler.upload && (req.method === "POST" || req.method === "PATCH")) {
					const buffers = []
					req.on("data", chunk => {
						buffers.push(chunk)
					})
					req.on("end", () => {
						const body = Buffer.concat(buffers)
						if (handler.upload === "json") {
							let data
							try {
								data = JSON.parse(body.toString())
							} catch (e) {}
							handler.code({req, url, res, fill, body, data}).then(resolve, reject)
						} else {
							handler.code({req, url, res, fill, body}).then(resolve, reject)
						}
					})
				} else {
					handler.code({req, url, res, fill}).then(resolve, reject)
				}
			}).then(result => {
				// api is done, construct response from return value
				if (result === undefined) {
					cf.log(`${url.pathname} [API] returned undefined`, "error") // forgot to return?
					return
				}
				if (result === null) {
					if (this._shouldLog(url.pathname)) cf.log(`${url.pathname} [API] ignoring null`, "spam") // deliberate no response
					return
				}
				// headers
				if (!result.headers) result.headers = {}
				let combinedHeaders = Object.assign({"Content-Type": result.contentType}, this.config.globalHeaders, headers, result.headers)
				Object.entries(combinedHeaders).forEach(entry => {
					if (entry[1] == null) delete combinedHeaders[entry[0]] // set header value null to delete. this can be used to override globals from api. this is also jank
				})
				// array
				if (result.constructor.name === "Array") {
					result = {statusCode: result[0], content: result[1]}
				}
				// write head
				if (!result.statusCode) throw new Error("Missing result.statusCode :: "+url.pathname)
				res.writeHead(result.statusCode, combinedHeaders)
				if (isHead) return res.end()
				// write body
				if (result.stream) {
					// stream
					if (this._shouldLog(url.pathname)) cf.log(`${url.pathname} [API] using stream`, "spam")
					result.stream.pipe(res)
				} else {
					// not stream
					if (!result.contentType) result.contentType = (typeof result.content === "object" ? "application/json" : "text/plain")
					if (typeof result.content === "number" || (typeof result.content === "object" && ["Object", "Array"].includes(result.content.constructor.name))) result.content = JSON.stringify(result.content)
					headers["Content-Length"] = Buffer.byteLength(result.content)
					res.write(result.content)
					res.end()
				}
			}).catch(err => {
				this._handleError(req, res, url, headers, isHead, err)
			})
		} // end of while loop
		return handled
	}

	/**
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 * @param {URL} url
	 */
	_handleWithPage(req, res, url, headers, isHead) {
		let i = 0
		let handled = false
		// try each handler
		while (!handled && i < this.pageHandlers.length) {
			const handler = this.pageHandlers[i]
			i++
			const re = new RegExp(`^${handler.web}$`)
			const match = url.pathname.match(re)
			if (!match) continue
			handled = true
			new Promise((resolve, reject) => {
				if (handler.type === "pug") {
					if (this.pugCache.has(handler.local)) {
						return resolve(this.pugCache.get(handler.local).web())
					} else {
						return reject(symbols.PUG_SOURCE_NOT_FOUND)
					}
				}
				handler.type === "pug"
					? resolve(this.pugCache.get(handler.local).web())
				: handler.type === "sass"
					? resolve(this.sassCache.get(handler.local))
				: handler.absolute
					? resolve(fs.promises.readFile(handler.local, "utf8"))
				: resolve(fs.promises.readFile(path.join(this.config.relativeRoot, handler.local), "utf8"))
			}).then(page => {
				headers["Content-Length"] = Buffer.byteLength(page)
				if (url.searchParams.has("statichash") && !headers["Cache-Control"]) headers["Cache-Control"] = `max-age=${30*24*60*60}, public`
				if (this._shouldLog(url.pathname)) cf.log(`[PAG] ${url.pathname} = ${handler.web} -> ${handler.local}`, "spam")
				res.writeHead(200, Object.assign({"Content-Type": mimeType(handler.web)}, headers, this.config.globalHeaders))
				if (isHead) return res.end()
				res.write(page)
				res.end()
			}).catch(error => {
				if (error === symbols.PUG_SOURCE_NOT_FOUND) {
					return this._handleError(req, res, url, headers, isHead, "Pug source file not found.")
				} else {
					return this._handleError(req, res, url, headers, isHead, error)
				}
			})
		} // end of while loop
		return handled
	}

	/**
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 * @param {URL} url
	 */
	_handleDirect(req, res, url, headers, isHead) {
		// If THAT fails, try reading the html directory for a matching file
		let filename = path.join(this.config.relativeRoot, this.config.filesDir, url.pathname)
		let inPublic = filename.startsWith(path.join(this.config.relativeRoot, this.config.filesDir))
		if (!inPublic) cf.log("Non-public access attempt caught!", "warning")
		new Promise((resolve, reject) => {
			if (!inPublic) return reject()
			else return resolve(fs.promises.stat(filename))
		}).then(stats => {
			if (stats.isDirectory()) return Promise.reject()
			if (this._shouldLog(url.pathname)) cf.log(`[DIR] ${url.pathname}`, "spam")
			if (url.searchParams.has("statichash") && !headers["Cache-Control"]) headers["Cache-Control"] = `max-age=${30*24*60*60}, public`
			let ranged = toRange(stats.size, headers, req)
			headers["Content-Length"] = ranged.length
			res.writeHead(ranged.statusCode, Object.assign({"Content-Type": mimeType(url.pathname)}, headers, this.config.globalHeaders))
			if (isHead) return res.end()
			let stream = fs.createReadStream(filename, {start: ranged.start, end: ranged.end})
			stream.pipe(res)
		}).catch(() => {
			if (this._shouldLog(url.pathname)) cf.log(`[404] ${url.pathname}`, "spam")
			if (this.notFoundTarget) {
				// rewrite request to be that url instead
				const params = new URLSearchParams()
				params.set("pathname", url.pathname)
				req.url = this.notFoundTarget + "?" + params.toString()
				return this._handleRequest(req, res)
			} else {
				res.writeHead(404, Object.assign({"Content-Type": "text/plain; charset=UTF-8"}, this.config.globalHeaders))
				if (isHead) return res.end()
				res.write("404 Not Found")
				res.end()
			}
		})
	}

	_handleError(req, res, url, headers, isHead, err) {
		res.writeHead(500, {"Content-Type": "text/plain; charset=UTF-8"})
		if (isHead) return res.end()
		res.write(
				`           ◸―――――――――――――――――――――――――――――――――――――◹`
			+`\n     ···<  |        500. That's an error.        |  >···`
			+`\n           ◺―――――――――――――――――――――――――――――――――――――◿`
			+`\n\n`
			+`\n ╱  Are you visiting this website? Not sure what's going on?  ╲`
			+`\n ╲             You might want to come back later.             ╱`
			+`\n\n\n`
			+`\n`+(err && err.stack ? err.stack : err && err.message ? err.message : err)
		)
		res.end()
	}
}

module.exports.Pinski = Pinski
