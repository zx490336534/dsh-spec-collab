declare module '@toast-ui/editor' {
  export interface EditorOptions {
    el: HTMLElement
    initialValue?: string
    initialEditType?: 'markdown' | 'wysiwyg'
    hideModeSwitch?: boolean
    toolbarItems?: unknown[][]
    plugins?: Array<(context: unknown) => unknown>
    height?: string
    language?: string
    usageStatistics?: boolean
    autofocus?: boolean
  }

  export default class ToastEditor {
    constructor(options: EditorOptions)
    on(type: string, handler: () => void): void
    getMarkdown(): string
    setMarkdown(markdown: string): void
    getSelectedText(): string
    destroy(): void
  }
}

declare module '@toast-ui/editor/dist/i18n/zh-cn'
