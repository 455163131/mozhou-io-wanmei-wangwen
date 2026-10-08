/**
 * CSS Modules 类型声明。
 * Vite 会在构建时把 `import styles from './x.module.css'` 转成对象；
 * 但 tsc 需要这个声明才知道它是对象而不是 `any`。
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css' {
  const content: string;
  export default content;
}