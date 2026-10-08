import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react'
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
  onChange?: (value: string) => void
  readOnly?: boolean
  language?: string
  suggestions?: string[]
  height?: string | number
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

let eplConfigured = false

function configureEpl(instance: typeof monaco) {
  if (eplConfigured) return
  instance.languages.register({ id: 'epl' })
  instance.languages.setMonarchTokensProvider('epl', {
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*[\s\S]*?\*\//, 'comment'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b(?:select|from|where|insert|into|as|and|or|not|group|by|having|match_recognize|partition|measures|define|pattern|every|timer|interval|within|create|schema)\b/i, 'keyword'],
        [/#(?:time|time_batch)\b/i, 'type'],
        [/[A-Za-z_][A-Za-z0-9_]*/, 'identifier'],
        [/\d+(?:\.\d+)?/, 'number'],
      ],
    },
  })
  eplConfigured = true
}

export default function MonacoTextEditor({ value, onChange, readOnly = true, language = 'plaintext', suggestions = [], height = '100%' }: MonacoTextEditorProps) {
  const beforeMount: BeforeMount = instance => {
    configureTheme(instance)
    if (language === 'epl') configureEpl(instance)
  }
  const onMount: OnMount = (editor, instance) => {
    if (language !== 'epl' || !suggestions.length) return
    const disposable = instance.languages.registerCompletionItemProvider('epl', {
      provideCompletionItems: () => ({
        suggestions: suggestions.map(label => ({ label, kind: instance.languages.CompletionItemKind.Field, insertText: label })),
      }),
    })
    editor.onDidDispose(() => disposable.dispose())
  }
  return (
    <Editor
      height={height}
      value={value}
      language={language}
      theme="rts-light"
      beforeMount={beforeMount}
      onMount={onMount}
      onChange={next => onChange?.(next || '')}
      options={{
        readOnly,
        domReadOnly: readOnly,
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
        contextmenu: !readOnly,
        overviewRulerLanes: 0,
        padding: { top: 14, bottom: 14 },
      }}
    />
  )
}
