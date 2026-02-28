import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: {
    file: 'dist/index.esm.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    typescript({
      tsconfig: 'tsconfig.build.json',
      declaration: false, // We'll generate declarations separately
      declarationMap: false,
      // Include common workspace package source for TypeScript compilation
      include: ['src/**/*.ts', '../packages/common/src/**/*.ts'],
    }),
  ],
  external: [], // Bundle everything for now
};
