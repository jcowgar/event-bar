// ESLint flat config for a GNOME Shell 50 extension (GJS ES modules).
// Run `npm install` once, then `npm run lint` (or `npm run lint:fix`).
//
// The GJS runtime injects a handful of globals that aren't part of standard
// JavaScript (`global`, `log`, `logError`, `console`, the text codecs, …);
// they're declared below so `no-undef` doesn't flag legitimate use.

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';

export default [
    {
        // Not source: generated, packaging, and translation artifacts.
        ignores: ['schemas/gschemas.compiled', 'po/**', 'node_modules/**'],
    },
    js.configs.recommended,
    // Formatting layer matching gnome-shell's own house style: 4-space indent,
    // single quotes, semicolons, no spaces inside braces, trailing commas on
    // multiline, and `arrowParens: false` = as-needed-but-required-for-block-body
    // (so `i => i + 1` stays bare while `(x) => { … }` takes parens).
    // `npm run lint:fix` auto-applies it.
    stylistic.configs.customize({
        indent: 4,
        quotes: 'single',
        semi: true,
        arrowParens: false,
        braceStyle: '1tbs',
        commaDangle: 'always-multiline',
    }),
    {
        rules: {
            '@stylistic/object-curly-spacing': ['error', 'never'],
        },
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // GJS / GNOME Shell runtime injections.
                ARGV: 'readonly',
                Debugger: 'readonly',
                GIRepositoryGType: 'readonly',
                global: 'readonly',
                globalThis: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            },
        },
        rules: {
            // Catch real leaks/typos; these are the rules that matter for an
            // extension that must clean up every resource in disable().
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'no-undef': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'smart'],
        },
    },
];
