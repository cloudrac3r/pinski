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

module.exports.setInstance = setInstance
module.exports.render = render
module.exports.redirect = redirect
module.exports.instance = instance
