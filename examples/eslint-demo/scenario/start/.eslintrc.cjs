// This v9-era configuration is intentionally obsolete for the pinned v10 runtime.
module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: {
    "no-undef": "error",
    "no-unused-vars": "error",
    "eqeqeq": ["error", "always"]
  }
};
