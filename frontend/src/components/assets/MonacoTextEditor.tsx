import Editor, { loader, type BeforeMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: { getWorker: () => Worker }
}

const monacoGlobal = globalThis as MonacoGlobal
monacoGlobal.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

interface MonacoTextEditorProps {
  value: string
}

const configureTheme: BeforeMount = (instance) => {
  instance.editor.defineTheme('rts-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1a1a1a',
      'editorLineNumber.foreground': '#a8a8a8',
      'editorLineNumber.activeForeground': '#525252',
      'editor.lineHighlightBackground': '#f7f9fb',
      'editor.selectionBackground': '#dbeaff',
      'editorGutter.background': '#fafafa',
    },
  })
}

export default function MonacoTextEditor({ value }: MonacoTextEditorProps) {
  return (
    <Editor
      value={value}
      language="plaintext"
      theme="rts-light"
      beforeMount={configureTheme}
      options={{
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: '"JetBrains Mono", "Source Han Mono", "Courier New"',
        fontSize: 12,
        lineHeight: 21,
        lineNumbersMinChars: 3,
        folding: false,
        glyphMargin: false,
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        contextmenu: false,
        overviewRulerLanes: 0,
        padding: { top: 14, bottom: 14 },
      }}
    />
  )
}
