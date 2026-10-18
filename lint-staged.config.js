// lint-staged：仅对暂存区文件执行检查，保证提交速度
// 文件多时把全部路径拼进一条命令会超出 Windows 的命令行长度上限（报「命令行太长」），故按批切分
const CHUNK_SIZE = 32;

/** 把文件列表按固定大小切成多批，避免单条命令参数过长 */
const chunk = (files, size = CHUNK_SIZE) => {
  const batches = [];
  for (let index = 0; index < files.length; index += size) {
    batches.push(files.slice(index, index + size));
  }
  return batches;
};

/** 拼成带引号的参数串，兼容路径中出现空格的情况 */
const toArgs = (files) => files.map((file) => `"${file}"`).join(' ');

export default {
  '*.{js,mjs,cjs,ts,vue}': (files) => {
    const batches = chunk(files);
    return [
      ...batches.map((batch) => `eslint --fix ${toArgs(batch)}`),
      ...batches.map((batch) => `prettier --write ${toArgs(batch)}`),
    ];
  },
  '*.{json,md,html,css,scss}': (files) =>
    chunk(files).map((batch) => `prettier --write ${toArgs(batch)}`),
};
