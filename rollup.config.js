import typescript from "@rollup/plugin-typescript";
import node from "@rollup/plugin-node-resolve";
import json from "@rollup/plugin-json";
import esbuild from "./scripts/rollup-plugin-esbuild";
import { dependencies } from "./package.json";

process.env.BUILD = "production";

/** @type Array<import('rollup').RollupOptions> */
const configs = [
  {
    input: [`./src/index.ts`, `./src/cli.ts`, `./src/action.ts`],
    output: {
      format: "cjs",
      dir: "lib/",
      preferConst: true,
      sourcemap: true,
      plugins: [
        esbuild({
          platform: "node",
          target: `node14.14`,
          bundle: true,
          treeShaking: true,
          external: [],
        }),
      ],
    },
    external: [...Object.keys(dependencies)],
    plugins: [json(), node(), typescript({ tsconfig: `./tsconfig.json` })],
  },
];

export default configs;
