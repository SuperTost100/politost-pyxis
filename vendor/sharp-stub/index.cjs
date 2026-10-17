// transformers.node.mjs imports sharp at load time and throws when its default export is falsy,
// so this stub exports a function. Only image pipelines call it, and Pyxis runs none.
module.exports = function sharp() {
  throw new Error("Image processing is not available in Pyxis");
};
