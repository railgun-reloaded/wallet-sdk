import railgunEslintConfig from '@railgun-reloaded/eslint-config'

export default [
  {
    ignores: ['config/**', 'fixtures/**']
  },
  ...railgunEslintConfig(),
]
