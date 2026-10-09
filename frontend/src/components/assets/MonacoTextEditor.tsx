import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
import { useEffect, useRef } from 'react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { CollaborationSelection } from '../../api/collaboration'

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
  onSelectionChange?: (selection: CollaborationSelection) => void
  remoteSelections?: Array<{ clientId: string; name: string; selection: CollaborationSelection }>
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

export default function MonacoTextEditor({ value, onChange, readOnly = true, language = 'plaintext', suggestions = [], height = '100%', onSelectionChange, remoteSelections = [] }: MonacoTextEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const remoteSelectionsRef = useRef(remoteSelections)
  const applyRemoteSelections = () => {
    if (!editorRef.current) return
    decorationsRef.current?.set(remoteSelectionsRef.current.map((remote, index) => ({
      range: new monaco.Range(remote.selection.startLineNumber, remote.selection.startColumn, remote.selection.endLineNumber, remote.selection.endColumn),
      options: {
        className: `collaboration-selection collaboration-color-${index % 6}`,
        beforeContentClassName: `collaboration-cursor collaboration-color-${index % 6}`,
        hoverMessage: { value: remote.name },
      },
    })))
  }
  useEffect(() => {
    remoteSelectionsRef.current = remoteSelections
    applyRemoteSelections()
  }, [remoteSelections])
  const beforeMount: BeforeMount = instance => {
    configureTheme(instance)
    if (language === 'epl') configureEpl(instance)
  }
  const onMount: OnMount = (editor, instance) => {
    editorRef.current = editor
    decorationsRef.current = editor.createDecorationsCollection()
    applyRemoteSelections()
    const cursorDisposable = editor.onDidChangeCursorSelection(event => onSelectionChange?.({
      startLineNumber: event.selection.startLineNumber,
      startColumn: event.selection.startColumn,
      endLineNumber: event.selection.endLineNumber,
      endColumn: event.selection.endColumn,
    }))
    const completionDisposable = language === 'epl' && suggestions.length
      ? instance.languages.registerCompletionItemProvider('epl', {
          provideCompletionItems: () => ({
            suggestions: suggestions.map(label => ({ label, kind: instance.languages.CompletionItemKind.Field, insertText: label })),
          }),
        })
      : null
    editor.onDidDispose(() => {
      editorRef.current = null
      decorationsRef.current = null
      cursorDisposable.dispose()
      completionDisposable?.dispose()
    })
  }
  return (
    <Editor
      height={height}
      value={value}
      language={language}
      theme="rts-light"
      beforeMount={beforeMount}
      onMount={onMount}
      onChange={next => { const nextValue = next || ''; if (nextValue !== value) onChange?.(nextValue) }}
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
