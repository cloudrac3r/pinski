const http = require("http")
const https = require("https")
const pj = require("path").join

/** @type {import("./index").Pinski} */
let instance = null

function setInstance(i) {
	instance = i
}

function render(statusCode, filename, locals = undefined) {
	if (!locals) locals = {}
	locals.getStaticURL = getStaticURL
	const page = instance.pugCache.get(filename).web(locals)
	return {
		statusCode,
		contentType: "text/html",
		content: page
	}
}

function redirect(url, statusCode = 303) {
	return {
		statusCode,
		contentType: "text/html",
		content: "Redirecting...",
		headers: {
			"Location": url
		}
	}
}

/**
 * @param {string|URL} url
 */
function proxy(url, headers = {}) {
	return new Promise(resolve => {
		if (typeof url === "string") url = new URL(url)
		const requester = url.protocol === "http:" ? http : url.protocol === "https:" ? https : null
		const req = requester.request(url, res => {
			resolve({
				statusCode: res.statusCode,
				headers: headers,
				stream: res
			})
		})
		req.end()
	})
}

function getStaticURL(root, url) {
	const path = pj(root, url)
	if (instance.staticFileTable.has(path)) {
		const value = instance.staticFileTable.get(path)
		if (value.type === "static") {
			return `${url}?statichash=${value.hash}`
		} else if (value.type === "sass") {
			return instance.pageHandlers.find(h => h.local === path).web + `?statichash=${value.hash}`
		}
	}
	console.log(`Huh: Tried to get static hash but not in table for ${root} :: ${path}`)
	return url
}

module.exports.setInstance = setInstance
module.exports.render = render
module.exports.redirect = redirect
module.exports.instance = instance
module.exports.proxy = proxy
module.exports.getStaticURL = getStaticURL
