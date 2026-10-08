/**
 * 应用菜单。
 * 大部分菜单项只发 IPC 给渲染层，让 UI 自己决定怎么响应——
 * 菜单不直接调主进程逻辑，避免两套入口行为不一致。
 */
import { Menu, type BrowserWindow } from 'electron';
import { APP_BRAND_NAME } from '@shared/constants/brand';

export function buildMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_BRAND_NAME,
            submenu: [
              { role: 'about' as const, label: `关于${APP_BRAND_NAME}` },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏' },
              { role: 'hideOthers' as const, label: '隐藏其它' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开项目…',
          accelerator: 'CmdOrCtrl+O',
          click: () => win.webContents.send('menu:action', { action: 'open-project' }),
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => win.webContents.send('menu:action', { action: 'save' }),
        },
        { type: 'separator' },
        {
          label: '导出投稿稿…',
          accelerator: 'CmdOrCtrl+E',
          click: () => win.webContents.send('menu:action', { action: 'export' }),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        {
          label: '叫停（保留已改）',
          accelerator: 'CmdOrCtrl+.',
          click: () => win.webContents.send('menu:action', { action: 'abort-run' }),
        },
        {
          label: '回滚到上一步',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => win.webContents.send('menu:action', { action: 'undo-last' }),
        },
        { type: 'separator' },
        {
          label: '重建风格基线',
          click: () => win.webContents.send('menu:action', { action: 'rebuild-baseline' }),
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '快捷键',
          click: () => win.webContents.send('menu:action', { action: 'show-shortcuts' }),
        },
        {
          label: '关于',
          click: () => win.webContents.send('menu:action', { action: 'show-about' }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}