import type { Plugin } from "vite";

// vite-plugin-commonjs prepends its hoisted imports and its `module` /
// `exports` polyfill as marker-delimited chunks on one line, directly in front
// of the module's original first byte.
const DISPLACED_HASHBANG_RE = /\[vite-plugin-commonjs\] [\w-]+-E \*\/#!/;

/**
 * Turns a hashbang that vite-plugin-commonjs's prepended code moved off byte 0
 * of `output`, the only place it is valid syntax, into a line comment. Returns
 * `undefined` when there is nothing to change.
 *
 * Next.js's webpack does the same for every module (CompatibilityPlugin
 * comments out a leading `#!`). `//` is as long as `#!`, so the plugin's
 * source map stays valid.
 */
export function commentOutDisplacedHashbang(output: string): string | undefined {
  const lineEnd = output.indexOf("\n");
  const match = DISPLACED_HASHBANG_RE.exec(lineEnd === -1 ? output : output.slice(0, lineEnd));
  if (!match) return undefined;
  const hashbang = match.index + match[0].length - 2;
  return `${output.slice(0, hashbang)}//${output.slice(hashbang + 2)}`;
}

/**
 * Applies {@link commentOutDisplacedHashbang} in the client dependency
 * optimizer's Rolldown builds (scan and pre-bundle), where
 * vite-plugin-commonjs's pre-bundle plugin loads and converts files without
 * vinext's transform wrapper. Its output reaches this hook as the loaded code.
 */
export const commonJsHashbangOptimizeDepsPlugin: Plugin = {
  name: "vinext:commonjs-hashbang:optimize-deps",
  transform: {
    filter: { code: { include: DISPLACED_HASHBANG_RE } },
    handler(code) {
      const output = commentOutDisplacedHashbang(code);
      // The replacement moves no code, so the existing mappings still hold.
      return output === undefined ? null : { code: output, map: null };
    },
  },
};
