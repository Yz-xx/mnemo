import type { ParseRunner } from '../../files/parseGovernance.js';

/**
 * 直通解析器：测试里只关心「解析被闸门包住」的调用形态、不关心水位时用它。
 * 任务原样执行，接口与生产实现（files/parseGovernance.ts）一致。
 */
export const PASSTHROUGH_PARSE: ParseRunner = {
  run<T>(task: () => Promise<T>): Promise<T> {
    return task();
  },
};
