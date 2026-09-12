/** 用于注入log4js的模块 */

let emit = (type, level, timestamp = new Date(), ...msgs) => { };
let emitSet = false;

function putEmit(emitFunc) {
  if (emitSet) throw new Error("重复设置 log4j_inject.emit()");
  emit = emitFunc;
  emitSet = true;
}

/**
 * log4js 自定义 appender 的入口。
 * @apiNote log4js 会直接把本模块当作 appender 加载并要求顶层具名导出 `configure`，
 *          因此本函数无法收纳进 NeonaicLog4jsInject 对象，属于本模块的例外导出。
 */
export const configure = (config, layouts, findAppender, levels) => /* return */((logEvent) => {
  // logEvent 结构：{ level: { levelStr: 'INFO' }, data: [arg1, arg2], categoryName: 'xxx', startTime: Date }
  const message = logEvent.data.map(item =>
    typeof item === 'string' ? item : JSON.stringify(item)
  );
  const date = logEvent.startTime;
  switch (logEvent.level.levelStr.toLowerCase()) {
    case 'all':
    case 'off':
    case 'trace':
    case 'debug':
      emit(null, 'debug', date, logEvent.categoryName, ...message);
      break;
    case 'info':
    case 'mark':
      emit(null, 'info', date, logEvent.categoryName, ...message);
      break;
    case 'warn':
      emit(null, 'warn', date, logEvent.categoryName, ...message);
      break;
    case 'error':
    case 'fatal':
      emit(null, 'error', date, logEvent.categoryName, ...message);
      break;

    default:
      break;
  }
});

export const NeonaicLog4jsInject = {
  putEmit,
};
