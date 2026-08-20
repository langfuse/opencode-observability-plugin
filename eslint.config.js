import parser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      parser,
    },
    rules: {
      curly: ["error", "all"],
    },
  },
];
