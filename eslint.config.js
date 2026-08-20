import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    rules: {
      curly: ["error", "all"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='Boolean']",
          message:
            "Avoid truthiness coercion. Use an explicit condition or comparison instead.",
        },
        {
          selector:
            "UnaryExpression[operator='!'] > BinaryExpression[operator='!=']",
          message:
            "Avoid negating comparisons. Use the inverse operator directly.",
        },
        {
          selector:
            "UnaryExpression[operator='!'] > BinaryExpression[operator='!==']",
          message:
            "Avoid negating comparisons. Use the inverse operator directly.",
        },
      ],
    },
  },
  ...[
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
  ].map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "never",
        },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/strict-void-return": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
];
