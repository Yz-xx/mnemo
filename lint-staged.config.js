// lint-staged：仅对暂存区文件执行检查，保证提交速度
export default {
  '*.{js,mjs,cjs,ts,vue}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,html,css,scss}': 'prettier --write',
};
