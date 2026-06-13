import config from '@iobroker/eslint-config';

export default [
    {
        ignores: ['build/**', 'node_modules/**'],
    },
    ...config,
    {
        rules: {
            'jsdoc/require-jsdoc': 'off',
        },
    },
];
