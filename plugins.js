const http = require("http")
const https = require("https")
const pj = require("path").join

/** @type {import("./index").Pinski} */
let instance = null

function setInstance(i) {
	instance = i
}

function render(statusCode, filename, locals = undefined) {
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

module.exports.setInstance = setInstance
module.exports.render = render
module.exports.redirect = redirect
module.exports.instance = instance
module.exports.proxy = proxy
