'use strict';
// Minimal stand-in for the `vscode` module, just enough surface for
// Decorator (src/render/decorations.ts) and its imports (config.ts) to run
// outside an editor. Not a general-purpose mock -- only what `render-stills.js`
// (#113, and before it #95's evidence harness) touches.

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
    this.isTrusted = false;
  }
}

let typeCounter = 0;
const decorationTypeCalls = [];

function createTextEditorDecorationType(options) {
  typeCounter += 1;
  const type = {
    key: `TextEditorDecorationType${typeCounter}`,
    _options: options,
    dispose() {},
  };
  return type;
}

const configValues = {};

function getConfiguration() {
  return {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(configValues, key)
        ? configValues[key]
        : fallback;
    },
  };
}

module.exports = {
  Position,
  Range,
  ThemeColor,
  MarkdownString,
  DecorationRangeBehavior: { ClosedOpen: 1, OpenOpen: 0 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  Uri: {
    joinPath(base, ...segments) {
      return { fsPath: `${base && base.fsPath}/${segments.join('/')}` };
    },
  },
  window: { createTextEditorDecorationType },
  workspace: { getConfiguration },
  _configValues: configValues,
  _decorationTypeCalls: decorationTypeCalls,
};
