const fs = require("fs");
const path = require("path");

module.exports = function(directory, includeDirectories, cache, compileFn) {
	doCompileAll();
	fs.watch(directory, (eventType, filename) => {
		//console.log(eventType, filename);
		let fullPath = path.join(directory, filename).replace(/\\/g, "/");
		if (fs.existsSync(fullPath)) {
			if (!fs.statSync(fullPath).isDirectory()) {
				doCompile(fullPath);
			}
		} else {
			cache.delete(fullPath);
		}
	});
	includeDirectories.forEach(include => {
		fs.watch(include, (eventType, filename) => {
			doCompileAll();
		});
	});
	function doCompileAll() {
		includeDirectories.concat(directory).forEach(directory => {
			fs.readdir(directory, (err, files) => {
				if (err) throw err;
				files.forEach(filename => {
					let fullPath = path.join(directory, filename).replace(/\\/g, "/");
					if (!fs.statSync(fullPath).isDirectory()) {
						doCompile(fullPath);
					}
				});
			});
		})
	}
	function doCompile(fullPath) {
		let result = compileFn(fullPath);
		if (result instanceof Promise) result.then(data => data && cache.set(fullPath, data));
		else if (result) cache.set(fullPath, result);
	}
}
