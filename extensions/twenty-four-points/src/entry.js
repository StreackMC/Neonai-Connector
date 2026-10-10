import { registerMathSupportForAI as registerHicky } from './hicky.js';
import { clearSession } from './session.js';

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 * @param {{ manifest: Object, pwd: String, ext_item_id: String, ext_item_timestamp: Number }} [ctx] 拓展上下文
 */
export function onEnable(ctx) {
  registerHicky();
}

/**
 * @this {import('../../../src/extension/extLoader.js').NeonaicExtItem}
 */
export function onDisable() {
  getAllSessionUser().map(clearSession);
}
