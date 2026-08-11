"use strict";

const safeBraceExpansion = require("brace-expansion-safe");

// minimatch 3 expects a callable CommonJS export, while newer releases use `.expand`.
function expand(pattern, options) {
  return safeBraceExpansion.expand(pattern, options);
}

module.exports = expand;
module.exports.expand = expand;
module.exports.EXPANSION_MAX = safeBraceExpansion.EXPANSION_MAX;
module.exports.EXPANSION_MAX_LENGTH = safeBraceExpansion.EXPANSION_MAX_LENGTH;
