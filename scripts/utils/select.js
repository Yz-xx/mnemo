import process from 'node:process';
import { emitKeypressEvents } from 'node:readline';

/**
 * 终端多选列表：↑/↓ 移动光标，空格切换选中，a 全选/全不选，回车确认，Esc/Ctrl+C 取消。
 * 用 node:readline 的 keypress 事件手写交互，避免为脚手架引入第三方交互库。
 * @param {object} options 配置项
 * @param {string} options.message 顶部提示语
 * @param {Array<{ label: string, value: string, hint?: string, checked?: boolean }>} options.items 候选项
 * @param {NodeJS.ReadStream} [options.input] 输入流，默认 process.stdin
 * @param {NodeJS.WriteStream} [options.output] 输出流，默认 process.stdout
 * @returns {Promise<string[] | null>} 被选中项的 value 列表；用户取消时返回 null
 */
export function multiSelect({ message, items, input = process.stdin, output = process.stdout }) {
  const checked = new Set();
  items.forEach((item, index) => {
    if (item.checked !== false) checked.add(index); // 未显式声明 checked 时默认选中
  });

  let cursor = 0;
  let renderedLines = 0; // 上一次渲染占用的行数，用于把光标退回列表首行

  return new Promise((resolve) => {
    // 逐行清空重写：相比整屏清屏不会闪烁，也不会抹掉此前的终端输出
    const draw = () => {
      if (renderedLines > 0) output.write(`\u001B[${renderedLines}A`);
      const lines = [
        message,
        ...items.map((item, index) => {
          const pointer = index === cursor ? '❯' : ' ';
          const box = checked.has(index) ? '◉' : '○';
          const hint = item.hint ? `  ${item.hint}` : '';
          return `${pointer} ${box} ${item.label}${hint}`;
        }),
      ];
      output.write(lines.map((line) => `\u001B[2K${line}\n`).join(''));
      renderedLines = lines.length;
    };

    const finish = (result) => {
      input.removeListener('keypress', onKeypress);
      if (typeof input.setRawMode === 'function') input.setRawMode(false);
      input.pause();
      output.write('\u001B[?25h'); // 恢复光标，避免结束后光标一直不可见
      resolve(result);
    };

    const onKeypress = (_str, key) => {
      if (key.ctrl && key.name === 'c') {
        finish(null);
        return;
      }

      switch (key.name) {
        case 'up':
          cursor = (cursor - 1 + items.length) % items.length;
          break;
        case 'down':
          cursor = (cursor + 1) % items.length;
          break;
        case 'space':
          if (checked.has(cursor)) checked.delete(cursor);
          else checked.add(cursor);
          break;
        case 'a':
          if (checked.size === items.length) checked.clear();
          else items.forEach((_item, index) => checked.add(index));
          break;
        case 'return':
        case 'enter':
          finish(items.filter((_item, index) => checked.has(index)).map((item) => item.value));
          return;
        case 'escape':
          finish(null);
          return;
        default:
          return; // 其余按键忽略，且不触发重绘
      }
      draw();
    };

    emitKeypressEvents(input);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    output.write('\u001B[?25l'); // 隐藏光标，避免重绘时跳动
    input.on('keypress', onKeypress);
    draw();
  });
}
