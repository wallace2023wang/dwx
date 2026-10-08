import { FileText, Layers3, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { FlowDefinition, FlowNodeKind } from '../../types'

interface FlowNodeData extends Record<string, unknown> {
  label: string
  detail?: string
  active: boolean
}

type AppNode = Node<FlowNodeData, FlowNodeKind>

const handleClass = '!size-2 !border-2 !border-white !bg-[#525252]'

function StartNode({ data }: NodeProps<AppNode>) {
  return (
    <div className="flex size-[76px] flex-col items-center justify-center rounded-full border-2 border-[#2e7d32] bg-[#e8f5e9] text-center shadow-sm">
      <strong className="text-[11px] font-semibold text-[#2e7d32]">{data.label}</strong>
      <span className="mt-0.5 max-w-[68px] text-center text-[8px] leading-[10px] text-ink-2" title={data.detail}>{data.detail}</span>
      <Handle type="source" position={Position.Right} className={handleClass} />
    </div>
  )
}

function GatewayNode({ data }: NodeProps<AppNode>) {
  return (
    <div className="relative flex size-[86px] rotate-45 items-center justify-center border-2 border-[#e65100] bg-[#fff8e1] shadow-sm">
      <span className="max-w-[66px] -rotate-45 text-center text-[10px] font-semibold leading-[13px] text-[#b84600]">{data.label}</span>
      <Handle id="yes" type="source" position={Position.Right} className={handleClass} />
      <Handle id="no" type="source" position={Position.Top} className={handleClass} />
      <Handle type="target" position={Position.Left} className={handleClass} />
    </div>
  )
}

function TaskNode({ data, selected, kind }: NodeProps<AppNode> & { kind: 'rule' | 'table' | 'group' }) {
  const Icon = kind === 'group' ? Layers3 : kind === 'table' ? Table2 : FileText
  const tone = kind === 'group'
    ? 'border-brand-primary bg-[#f7faff] text-brand-primary'
    : kind === 'table'
      ? 'border-[#7c3aed] bg-[#fbf9ff] text-[#7c3aed]'
      : 'border-[#697077] bg-white text-[#525252]'
  return (
    <div className={`flex h-[70px] w-[210px] items-center gap-2.5 rounded-[3px] border-[1.5px] px-3 shadow-sm ${data.active ? tone : 'border-dashed border-ink-3 bg-[#fafafa] text-ink-3'} ${selected ? 'outline outline-2 outline-offset-2 outline-brand-primary' : ''}`}>
      <span className="flex size-8 shrink-0 items-center justify-center border border-current bg-white"><Icon size={16} /></span>
      <span className="min-w-0 text-left">
        <strong className={`block truncate text-xs font-semibold ${data.active ? 'text-ink-1' : 'text-ink-2'}`} title={data.label}>{data.label}</strong>
        <span className="mt-1 block truncate text-[10px] text-ink-3" title={data.detail}>{data.detail}</span>
      </span>
      <Handle type="target" position={Position.Left} className={handleClass} />
      <Handle type="source" position={Position.Right} className={handleClass} />
    </div>
  )
}

function RuleTaskNode(props: NodeProps<AppNode>) { return <TaskNode {...props} kind="rule" /> }
function TableTaskNode(props: NodeProps<AppNode>) { return <TaskNode {...props} kind="table" /> }
function RuleGroupNode(props: NodeProps<AppNode>) { return <TaskNode {...props} kind="group" /> }

function EndNode({ data }: NodeProps<AppNode>) {
  return (
    <div className="flex size-[76px] flex-col items-center justify-center rounded-full border-2 border-[#c62828] bg-[#ffebee] text-center shadow-sm">
      <strong className="text-[11px] font-semibold text-[#c62828]">{data.label}</strong>
      <span className="mt-0.5 max-w-[68px] text-center text-[8px] leading-[10px] text-ink-2" title={data.detail}>{data.detail}</span>
      <Handle type="target" position={Position.Left} className={handleClass} />
      <Handle id="top" type="target" position={Position.Top} className={handleClass} />
    </div>
  )
}

const nodeTypes: NodeTypes = {
  start: StartNode,
  gateway: GatewayNode,
  ruleTask: RuleTaskNode,
  tableTask: TableTaskNode,
  ruleGroup: RuleGroupNode,
  end: EndNode,
}

function ResponsiveFitView({ revision, disabled }: { revision: string; disabled: boolean }) {
  const { fitView } = useReactFlow()

  useEffect(() => {
    if (disabled) return undefined
    let frame = 0
    const refit = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => void fitView({ padding: 0.16, minZoom: 0.28, maxZoom: 1, duration: 180 }))
    }
    refit()
    window.addEventListener('resize', refit)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', refit)
    }
  }, [disabled, fitView, revision])

  return null
}

interface FlowCanvasProps {
  flow: FlowDefinition
  compact?: boolean
  editable?: boolean
  selectedNodeId?: string | null
  onNodeSelect?: (nodeId: string | null) => void
  onNodeMove?: (nodeId: string, position: { x: number; y: number }) => void
  onDropItem?: (item: { type: 'rule-group' | 'rule' | 'table' | 'gateway'; id?: string; packageName?: string }, position: { x: number; y: number }) => void
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void
  initialViewport?: { x: number; y: number; zoom: number }
}

export default function FlowCanvas({ flow, compact = false, editable = false, selectedNodeId, onNodeSelect, onNodeMove, onDropItem, onViewportChange, initialViewport }: FlowCanvasProps) {
  const mappedNodes = useMemo<AppNode[]>(() => flow.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: node.position,
    data: { label: node.label, detail: node.detail, active: node.active !== false },
    draggable: editable,
    selectable: editable,
    selected: node.id === selectedNodeId,
  })), [editable, flow.nodes, selectedNodeId])
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(mappedNodes)
  const [instance, setInstance] = useState<ReactFlowInstance<AppNode, Edge> | null>(null)

  useEffect(() => setNodes(mappedNodes), [mappedNodes, setNodes])

  const edges = useMemo<Edge[]>(() => flow.connections.map((connection) => ({
    id: connection.id,
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
    label: connection.label,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#525252', width: 14, height: 14 },
    style: { stroke: '#525252', strokeWidth: 1.4 },
    labelStyle: {
      fill: connection.labelTone === 'positive' ? '#2e7d32' : connection.labelTone === 'negative' ? '#c62828' : '#525252',
      fontSize: 11,
      fontWeight: 600,
    },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
  })), [flow.connections])
  const viewportRevision = useMemo(() => JSON.stringify([
    flow.nodes.map(node => node.id),
    flow.connections.map(connection => [connection.id, connection.source, connection.target]),
  ]), [flow.connections, flow.nodes])

  return (
    <section className={`${compact ? 'h-[560px] min-h-[560px] border-0' : 'h-[460px] min-h-[460px] rounded-[3px] border border-ink-border'} overflow-hidden bg-white`} aria-label={`${flow.name}画布`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView={!initialViewport}
        defaultViewport={initialViewport}
        fitViewOptions={{ padding: 0.16, minZoom: 0.28, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.5}
        onInit={setInstance}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => onNodeSelect?.(node.id)}
        onPaneClick={() => onNodeSelect?.(null)}
        onNodeDragStop={(_event, node) => onNodeMove?.(node.id, node.position)}
        onDragOver={event => { if (editable && onDropItem) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
        onDrop={event => {
          if (!editable || !onDropItem) return
          event.preventDefault()
          try {
            const item = JSON.parse(event.dataTransfer.getData('application/decision-workbench-flow'))
            if (instance) onDropItem(item, instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
          } catch { /* Ignore unrelated browser drops. */ }
        }}
        onMoveEnd={(_event, viewport) => onViewportChange?.(viewport)}
        nodesConnectable={false}
        nodesDraggable={editable}
        elementsSelectable={editable}
        proOptions={{ hideAttribution: true }}
      >
        <ResponsiveFitView revision={viewportRevision} disabled={Boolean(initialViewport)} />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d9d9d9" />
        <Controls showInteractive={editable} position="top-right" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          style={{ width: 140, height: 84 }}
          nodeColor={(node) => {
            if (node.type === 'start') return '#2e7d32'
            if (node.type === 'gateway') return '#e65100'
            if (node.type === 'end') return '#c62828'
            if (node.type === 'tableTask') return '#7c3aed'
            return '#0f62ff'
          }}
          maskColor="rgba(244, 244, 244, 0.72)"
        />
      </ReactFlow>
    </section>
  )
}
