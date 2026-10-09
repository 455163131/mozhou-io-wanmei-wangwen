import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { commitTheme } from './lib/theme-dom';
import { readTheme } from './lib/theme';
import { useSettingsStore } from './store';
import './styles/global.css';

/**
 * ★ 皮肤要在**首帧之前**落到根元素上，不能等 React 挂载后再设——
 *   否则暗色用户每次启动都先闪一屏浅色纸面。
 *   同时把读到的值同步进 store：store 的初值是 DEFAULT_THEME（它归 node 工程管，
 *   碰不到 localStorage），不同步的话设置页里那颗段控件会显示成"没选中的那个"。
 */
const savedTheme = readTheme(localStorage);
commitTheme(savedTheme);
useSettingsStore.getState().setTheme(savedTheme);

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);