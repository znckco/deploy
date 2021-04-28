import { build } from "esbuild";
import Path from "path";
/**
 * @param {import('esbuild').BuildOptions} config
 * @returns {import('rollup').Plugin}
 */
export default function createESBuildPlugin(config) {
  return {
    name: "ESBuild",
    async generateBundle({ format, dir }, bundle) {
      const abs = /** @param {string} fileName */ (fileName) =>
        Path.isAbsolute(fileName) ? fileName : Path.resolve(process.cwd(), dir, fileName);
      const chunks = Object.fromEntries(
        Object.values(bundle)
          .map((chunk) => (chunk.type === "chunk" ? chunk : undefined))
          .filter(Boolean)
          .map((chunk) => [abs(chunk.fileName), chunk]),
      );

      const fileNames = Object.keys(chunks);
      const filter = new RegExp(
        `^(${fileNames.map((fileName) => fileName.replace(/[\|\+\*\^\$\.]/g, (ch) => `\\${ch}`)).join("|")})$`,
      );

      const output = await build({
        platform: "node",
        format: format === "cjs" ? "cjs" : format === "iife" ? "iife" : "esm",
        bundle: true,
        incremental: false,
        allowOverwrite: true,
        outdir: dir,
        ...config,
        write: false,
        sourcemap: false,
        entryPoints: fileNames,
        plugins: [
          {
            name: "Loader",
            setup: (build) => {
              build.onResolve({ filter: /\.js$/ }, ({ path }) => {
                return abs(path) in chunks ? { path: abs(path) } : null;
              });
              build.onLoad({ filter }, ({ path }) => {
                return path in chunks ? { contents: chunks[path].code } : null;
              });
            },
          },
        ],
      });

      output.outputFiles.forEach((outputFile) => {
        chunks[outputFile.path].code = outputFile.text;
      });
    },
  };
}
