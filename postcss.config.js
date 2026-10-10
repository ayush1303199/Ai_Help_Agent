import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function getPlugins() {
  try {
    require.resolve('@tailwindcss/postcss');
    return { '@tailwindcss/postcss': {} };
  } catch {
    return {
      tailwindcss: {},
      autoprefixer: {},
    };
  }
}

export default {
  plugins: getPlugins(),
};
