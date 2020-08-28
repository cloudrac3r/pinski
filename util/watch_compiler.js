const fs = require("fs");
const path = require("path");

function pathIsUseful(fullPath) {
	return (
		!fs.statSync(fullPath).isDirectory()
			&& !fullPath.endsWith("~")
			&& !fullPath.startsWith(".")
			&& !fullPath.includes("/.")
			&& !fullPath.endsWith("#")
	)
}

/**
 * @param {string} directory
 * @param {string[]} includeDirectories
 */
module.exports = function(directory, includeDirectories, cache, compileFn) {
	const watchers = []
	watchers.push(
		fs.watch(directory, (eventType, filename) => {
			//console.log(eventType, filename);
			let fullPath = path.join(directory, filename).replace(/\\/g, "/");
			if (fs.existsSync(fullPath)) {
				if (pathIsUseful(fullPath)) {
					doCompile(fullPath);
				}
			} else {
				cache.delete(fullPath);
			}
		})
	)
	includeDirectories.forEach(include => {
		watchers.push(
			fs.watch(include, (eventType, filename) => {
				doCompileAll();
			})
		)
	});
	function doCompileAll() {
		return Promise.all(
			includeDirectories.concat(directory).map(async directory => {
				const files = await fs.promises.readdir(directory)
				await Promise.all(files.map(async filename => {
					let fullPath = path.join(directory, filename).replace(/\\/g, "/");
					if (pathIsUseful(fullPath)) {
						await doCompile(fullPath);
					}
				}))
			})
		)
	}
	async function doCompile(fullPath) {
		let result = await compileFn(fullPath);
		if (result) cache.set(fullPath, result);
	}
	return {
		compiler: doCompileAll(),
		shutdown: () => {
			for (const watcher of watchers) {
				watcher.close()
				watcher.removeAllListeners()
			}
		}
	}
}
