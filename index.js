//@ts-check

const fs = require("fs");
const http = require("http");
const https = require("https");
const tls = require("tls");
const path = require("path");
const mime = require("mime");
const cf = require("./util/common.js");
const pug = require("pug");
const sass = require("node-sass");
const watchAndCompile = require("./util/watch_compiler.js");
const WebSocket = require("ws")

module.exports = function(input) {
    let config = {
        hostnames: ["localhost"],
        httpPort: 8080,
        httpsPort: null,
        apiDir: "api",
        templatesDir: "templates",
        filesDir: "html",
        pugDir: "",
        pugIncludeDirs: [],
        globalHeaders: {},
        pageHandlers: [],
        basicCacheControl: {
            exts: ["ttf", "png", "jpg", "svg", "gif", "webmanifest", "ico"],
            seconds: 604800
        },
        ip: "0.0.0.0",
        relativeRoot: "",
        ws: false
    }
    Object.assign(config, input);

    let options;
    if (config.httpsPort) {
        function getFiles(hostname) {
            return {
                key: fs.readFileSync(`/etc/letsencrypt/live/${hostname}/privkey.pem`),
                cert: fs.readFileSync(`/etc/letsencrypt/live/${hostname}/cert.pem`),
                ca: [
                    fs.readFileSync(`/etc/letsencrypt/live/${hostname}/fullchain.pem`)
                ]
            };
        }
        function getSecureContext(hostname) {
            return tls.createSecureContext(getFiles(hostname));
        }
        let secureContexts = {};
        config.hostnames.forEach(hostname => {
            secureContexts[hostname] = getSecureContext(hostname);
        });
        options = getFiles(config.hostnames[0]);
        options.SNICallback = function(domain, callback) {
            if (secureContexts[domain]) {
                callback(null, secureContexts[domain]);
            } else {
                callback(null, Object.values(secureContexts)[0]);
            }
        }
    }

    /** @type {Map<string, (locals?: any) => string>} */
    let pugCache = new Map();
    if (config.pugDir) watchAndCompile(config.pugDir, config.pugIncludeDirs, pugCache, fullPath =>
        pug.compileFile(fullPath, {doctype: "html"})
    )
    /** @type {Map<string, string>} */
    let sassCache = new Map();
    if (config.sassDir) watchAndCompile(config.sassDir, [], sassCache, fullPath =>
        fs.promises.readFile(fullPath, {encoding: "utf8"}).then(data =>
            data ? sass.renderSync({data, indentedSyntax: true}).css.toString() : null
        )
    )

    let routeHandlers = [];
    const routeStore = new Map();
    const cancelStore = new Map();
    function rebuildRoutes() {
        //console.log("Building routes: "+routeStore.size+" items in map")
        routeHandlers = [].concat(...routeStore.values())
    }
    const loadAPI = () => {
        watchAndCompile(path.join(config.relativeRoot, config.apiDir), [], new Map(), async fullPath => {
            if (cancelStore.has(fullPath)) {
                const cancel = cancelStore.get(fullPath)
                cancelStore.delete(fullPath)
                cancel()
            }
            delete require.cache[require.resolve(fullPath)]
            let routes = require(fullPath)
            if (routes instanceof Array) {
                routes = routes.filter(r => {
                    if (r.cancel) {
                        cancelStore.set(fullPath, r.code)
                        return false
                    } else {
                        return true
                    }
                })
                //console.log("Adding new handers", routes)
                routeStore.set(fullPath, routes)
                rebuildRoutes()
            }
        })
        /*let apiFiles = fs.readdirSync(config.apiDir);
        apiFiles.forEach(f => {
            routeHandlers = routeHandlers.concat(
                require(path.join(config.relativeRoot, config.apiDir, f))
            );
        });*/
    }

    function mimeType(type) {
        const types = {
            "ttf": "application/font-sfnt",
            "ico": "image/x-icon",
            "sass": "text/css"
        };
        return types[type.split(".")[1]] || mime.getType(type);
    }

    function toRange(length, headers, req) {
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
        return {statusCode, start, end};
    }

    async function resolveTemplates(page) {
        let promises = [];
        let template;
        let regex = /<!-- TEMPLATE (\S+?) ?-->/g;
        while (template = regex.exec(page)) {
            let templateName = template[1];
            promises.push(new Promise(resolve => {
                fs.readFile(path.join(config.relativeRoot, config.templatesDir, templateName+".html"), {encoding: "utf8"}, (err, content) => {
                    if (err) resolve(undefined);
                    else resolve({template: templateName, content: content});
                });
            }));
        }
        let results = await Promise.all(promises);
        results.filter(r => r).forEach(result => {
            page = page.replace(new RegExp("<!-- TEMPLATE "+result.template+" ?-->"), () => result.content);
        });
        return page;
    }

    function serverRequest(req, res) {
        req.gmethod = req.method === "HEAD" ? "GET" : req.method;
        if (!req.headers.host) req.headers.host = config.hostnames[0];
        let headers = {};
        try {
            req.url = decodeURI(req.url);
        } catch (e) {
            res.writeHead(400, {"Content-Type": "text/plain"});
            res.end("Malformed URI");
            return;
        }
        if (config.basicCacheControl.exts.includes(req.url.split(".").slice(-1)[0])) headers["Cache-Control"] = `max-age=${config.basicCacheControl.seconds}, public`;
        let [reqPath, paramString] = req.url.split("?");
        if (reqPath.length > 5) reqPath = reqPath.replace(/\/+$/, "");
        let params = {};
        if (paramString) paramString.split("&").forEach(p => {
            let [key, value] = p.split("=");
            params[key] = value;
        });
        // Attempt to use routeHandlers first
        let foundRoute = routeHandlers.find(h => {
            if (!(h.route && h.methods)) return false
            let rr = new RegExp("^"+h.route+"$");
            let match = reqPath.match(rr);
            if (!(match && h.methods.includes(req.gmethod))) return false
            cf.log("Using routeHandler "+h.route+" to respond to "+reqPath, "spam");
            new Promise((resolve, reject) => {
                let fill = match.slice(1);
                if (req.method === "POST" || req.method === "PATCH") {
                    let buffers = [];
                    req.on("data", (chunk) => {
                        buffers.push(chunk);
                    });
                    req.on("end", (chunk) => {
                        let body = Buffer.concat(buffers);
                        let data;
                        try {
                            data = JSON.parse(body.toString());
                        } catch (e) {};
                        h.code({req, reqPath, res, fill, params, body, data}).then(resolve).catch(reject);
                    });
                } else {
                    h.code({req, reqPath, res, fill, params}).then(resolve).catch(reject);
                }
            }).then(result => {
                if (result === null) {
                    cf.log("Ignoring null response for request "+reqPath, "info");
                    return;
                }
                if (result && result.stream) {
                    cf.log("Using stream for request "+reqPath, "info");
                    if (!result.headers) result.headers = {};
                    let combinedHeaders = Object.assign({"Content-Type": result.contentType}, config.globalHeaders, headers, result.headers);
                    Object.entries(combinedHeaders).forEach(entry => {
                        if (entry[1] == null) delete combinedHeaders[entry[0]]
                    })
                    if (typeof(result.statusCode) === "number") res.writeHead(result.statusCode, combinedHeaders);
                    result.stream.pipe(res);
                } else {
                    if (result.constructor.name === "Array") {
                        let newResult = {statusCode: result[0], content: result[1]};
                        if (typeof(newResult.content) === "number") newResult.content = {code: newResult.content};
                        result = newResult;
                    }
                    if (!result.contentType) result.contentType = (typeof(result.content) == "object" ? "application/json" : "text/plain");
                    if (typeof(result.content) === "object" && ["Object", "Array"].includes(result.content.constructor.name)) result.content = JSON.stringify(result.content);
                    if (!result.headers) result.headers = {};
                    headers["Content-Length"] = Buffer.byteLength(result.content);
                    res.writeHead(result.statusCode, Object.assign({"Content-Type": result.contentType}, config.globalHeaders, headers, result.headers));
                    res.write(result.content);
                    res.end();
                }
            }).catch(err => {
                res.writeHead(500, {"Content-Type": "text/plain"});
                res.write(
                    `===| 500: Internal server error |===`
                    +`\n\nWhoopsie poopsie! Looks like there was a little fucky wucky in this code right here:`
                    +`\n\n`+err.stack
                    +`\n\n===| What can I do? |==`
                    +`\n\nIf you're visiting the site, please report this error.`
                    +`\n\nIf you made this mess, clean it up.`
                );
                res.end();
            });
            return true;
        });
        if (!foundRoute) {
            // If that fails, try pageHandlers
            foundRoute = config.pageHandlers.find(h => {
                let rr = new RegExp("^"+h.web+"$");
                let match = reqPath.match(rr);
                if (match) {
                    new Promise((resolve, reject) => {
                        if (h.type === "pug") resolve(resolveTemplates(pugCache.get(h.local)()));
                        else if (h.type === "sass") resolve(sassCache.get(h.local));
                        else fs.readFile(path.join(config.relativeRoot, h.local), {encoding: "utf8"}, (err, page) => {
                            if (err) reject(err);
                            else resolve(resolveTemplates(page));
                        });
                    }).then(page => {
                        headers["Content-Length"] = Buffer.byteLength(page);
                        cf.log("Using pageHandler "+h.web+" ("+h.local+") to respond to "+reqPath, "spam");
                        res.writeHead(200, Object.assign({"Content-Type": mimeType(h.local)}, headers, config.globalHeaders));
                        if (req.method === "HEAD") {
                            res.end();
                        } else {
                            res.write(page, () => {
                                res.end();
                            });
                        }
                    });
                    return true;
                } else {
                    return false;
                }
            });
            if (!foundRoute) {
                // If THAT fails, try reading the html directory for a matching file
                let filename = path.join(config.relativeRoot, config.filesDir, reqPath);
                let inPublic = filename.startsWith(path.join(config.relativeRoot, config.filesDir));
                fs.stat(filename, (err, stats) => {
                    if (!inPublic) cf.log("Non-public access attempt caught!", "warning");
                    if (err || stats.isDirectory() || !inPublic) {
                        cf.log("Couldn't handle request for "+reqPath+" → "+filename, "warning");
                        res.writeHead(404, Object.assign({"Content-Type": "text/plain"}, config.globalHeaders));
                        res.write("404 Not Found");
                        res.end();
                        return;
                    }
                    cf.log("Streaming "+reqPath+" → "+filename, "spam");
                    let ranged = toRange(stats.size, headers, req);
                    headers["Content-Length"] = ranged.end - ranged.start + 1
                    res.writeHead(ranged.statusCode, Object.assign({"Content-Type": mimeType(reqPath)}, headers, config.globalHeaders));
                    let stream = fs.createReadStream(filename, {start: ranged.start, end: ranged.end});
                    stream.pipe(res)
                });
            }
        }
    }

    function secureRedirect(req, res) {
        res.writeHead(301, {"Location": `https://${req.headers.host}${req.url}`});
        res.end();
    }

    let server = null
    if (config.httpsPort) {
        server = http.createServer(secureRedirect).listen(config.httpPort, config.ip);
        https.createServer(options, serverRequest).listen(config.httpsPort, config.ip);
    } else {
        server = http.createServer(serverRequest).listen(config.httpPort, config.ip);
    }
    let wss = null
    if (config.ws) {
        wss = new WebSocket.Server({server})
    }

    cf.log("Started server", "info");

    return {loadAPI, resolveTemplates, pugCache, sassCache, server, wss}
}
