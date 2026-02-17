'use client';

import { useCallback, useMemo, useEffect, useRef } from 'react';
import ReactFlow, {
    Node,
    Edge,
    Controls,
    Background,
    MiniMap,
    useNodesState,
    useEdgesState,
    BackgroundVariant,
    NodeChange,
    MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import styles from './styles.module.css';
import { WorkflowVisualizationProps } from "@/types";

// ── Helpers ──────────────────────────────────────────────────

interface NodeSnapshot { label: string; type: string }

function extractNodeMap(data: string | null): Map<string, NodeSnapshot> {
    if (!data) return new Map();
    try {
        const wf = JSON.parse(data);
        const map = new Map<string, NodeSnapshot>();
        (wf.nodes || []).forEach((n: any) => {
            map.set(n.id, { label: n.label || '', type: n.type || 'process' });
        });
        return map;
    } catch {
        return new Map();
    }
}

// ── Component ────────────────────────────────────────────────

export default function WorkflowVisualization({
    workflowData,
    chatId,
    onPositionChange,
    lockedNodes = {},
    onNodeDragStart,
    onNodeDragStop,
    isRemoteUpdate = false,
    streamingNodes = {},
}: WorkflowVisualizationProps) {
    const lastSavedDataRef = useRef<string | null>(null);
    const isRemoteRef = useRef(isRemoteUpdate);
    isRemoteRef.current = isRemoteUpdate;

    const prevWorkflowDataRef = useRef<string | null>(null);
    const prevChatIdRef = useRef<number | null>(null);
    useEffect(() => {
        if (chatId !== prevChatIdRef.current) {
            prevChatIdRef.current = chatId;
        }
    }, [chatId]);

    const parseWorkflow = useCallback((data: string | null) => {
        if (!data) return { nodes: [], edges: [] };

        try {
            const workflow = JSON.parse(data);

            const adjacencyMap = new Map<string, string[]>();
            workflow.edges.forEach((edge: any) => {
                if (!adjacencyMap.has(edge.from))
                    adjacencyMap.set(edge.from, []);
                adjacencyMap.get(edge.from)!.push(edge.to);
            });

            const incomingEdges = new Map<string, string[]>();
            workflow.edges.forEach((edge: any) => {
                if (!incomingEdges.has(edge.to)) incomingEdges.set(edge.to, []);
                incomingEdges.get(edge.to)!.push(edge.from);
            });

            const mergeNodes = new Set<string>();
            incomingEdges.forEach((sources, target) => {
                if (sources.length > 1) mergeNodes.add(target);
            });

            const positions = new Map<string, { x: number; y: number }>();
            const visited = new Set<string>();
            const currentY = 100;
            const verticalSpacing = 180;
            const horizontalSpacing = 350;
            const centerX = 400;

            const calculatePositions = (
                nodeId: string,
                x: number,
                y: number,
                isBranch: boolean = false,
                branchIndex: number = 0,
                totalBranches: number = 1
            ) => {
                if (visited.has(nodeId)) return;
                visited.add(nodeId);

                const node = workflow.nodes.find((n: any) => n.id === nodeId);
                if (!node) return;

                let nodeX = x;
                let nodeY = y;

                if (node.position) {
                    positions.set(nodeId, node.position);
                    nodeX = node.position.x;
                    nodeY = node.position.y;
                } else {
                    if (isBranch && totalBranches > 1) {
                        const offset = (branchIndex - (totalBranches - 1) / 2) * horizontalSpacing;
                        nodeX = centerX + offset;
                    }
                    positions.set(nodeId, { x: nodeX, y: nodeY });
                }

                const children = adjacencyMap.get(nodeId) || [];
                const isDecision = node.type === 'decision';
                const nextY = y + verticalSpacing;

                if (isDecision && children.length > 1) {
                    children.forEach((childId, index) => {
                        calculatePositions(childId, centerX, nextY, true, index, children.length);
                    });
                } else if (children.length === 1) {
                    const childId = children[0];
                    const isMerge = mergeNodes.has(childId);
                    if (isMerge) {
                        calculatePositions(childId, centerX, nextY, false, 0, 1);
                    } else {
                        calculatePositions(childId, nodeX, nextY, isBranch, branchIndex, totalBranches);
                    }
                } else if (children.length > 1 && !isDecision) {
                    children.forEach((childId, index) => {
                        calculatePositions(childId, centerX, nextY, true, index, children.length);
                    });
                }
            };

            const startNode = workflow.nodes.find((n: any) => n.type === 'start');
            if (startNode) {
                calculatePositions(startNode.id, centerX, currentY);
            } else if (workflow.nodes.length > 0) {
                calculatePositions(workflow.nodes[0].id, centerX, currentY);
            }

            const orphanedNodes = workflow.nodes.filter((node: any) => !visited.has(node.id));
            let orphanY = (visited.size + 1) * verticalSpacing + 100;
            orphanedNodes.forEach((node: any) => {
                if (!positions.has(node.id)) {
                    positions.set(node.id, { x: centerX, y: orphanY });
                    orphanY += verticalSpacing;
                }
            });

            const allNodes = [...workflow.nodes.filter((node: any) => visited.has(node.id)), ...orphanedNodes];

            const nodes: Node[] = allNodes.map((node: any) => {
                const position = positions.get(node.id) || { x: centerX, y: 100 };
                const isLocked = lockedNodes[node.id] !== undefined;
                const isStreamingNode = streamingNodes[node.id] !== undefined;

                let displayLabel = node.label;
                let displayDescription = node.description || '';
                if (isStreamingNode) {
                    const fullText = streamingNodes[node.id] || '';
                    const firstNewLine = fullText.indexOf('\n');
                    if (firstNewLine === -1) {
                        displayLabel = fullText;
                        displayDescription = '';
                    } else {
                        displayLabel = fullText.substring(0, firstNewLine);
                        displayDescription = fullText.substring(firstNewLine + 1).trim();
                    }
                }

                let labelContent = displayLabel;
                if (isLocked) {
                    labelContent = `\uD83D\uDD12 ${displayLabel} (${lockedNodes[node.id].username})`;
                }
                if (displayDescription) {
                    labelContent = `${displayLabel}\n${displayDescription}`;
                    if (isLocked) {
                        labelContent = `\uD83D\uDD12 ${displayLabel} (${lockedNodes[node.id].username})\n${displayDescription}`;
                    }
                }

                const getNodeBackground = () => {
                    if (isLocked) return '#6b7280';
                    switch (node.type) {
                        case 'start': return '#FC005C';
                        case 'end': return '#667eea';
                        case 'decision': return '#f6ad55';
                        default: return '#48bb78';
                    }
                };

                const getNodeBorder = () => {
                    if (isLocked) return '2px solid #ef4444';
                    return 'none';
                };

                return {
                    id: node.id,
                    type: 'default',
                    data: { label: labelContent },
                    position,
                    draggable: !isLocked,
                    style: {
                        background: getNodeBackground(),
                        color: 'white',
                        padding: '10px 20px',
                        borderRadius: node.type === 'decision' ? '8px' : '50px',
                        fontSize: '14px',
                        fontWeight: '500',
                        border: getNodeBorder(),
                        minWidth: '150px',
                        textAlign: 'center' as const,
                        opacity: isLocked ? 0.7 : 1,
                        transition: 'all 0.3s ease',
                        whiteSpace: 'pre-wrap' as const,
                    },
                };
            });

            const edges: Edge[] = workflow.edges.map((edge: any) => ({
                id: `e${edge.from}-${edge.to}`,
                source: edge.from,
                target: edge.to,
                animated: true,
                style: { stroke: '#667eea', strokeWidth: 2 },
                type: 'smoothstep',
                pathOptions: { offset: 35, borderRadius: 25 },
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    width: 20,
                    height: 20,
                    color: '#667eea',
                },
                sourceHandle: undefined,
            }));

            return { nodes, edges };
        } catch (error) {
            console.error('Failed to parse workflow:', error);
            return { nodes: [], edges: [] };
        }
    }, [lockedNodes, streamingNodes]);

    const { nodes: initialNodes, edges: initialEdges } = useMemo(
        () => parseWorkflow(workflowData),
        [workflowData, parseWorkflow]
    );

    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

    useEffect(() => {
        const streamingNodeIds = Object.keys(streamingNodes);
        if (streamingNodeIds.length > 0) {
            const { nodes: updatedNodes } = parseWorkflow(workflowData);
            setNodes((currentNodes) =>
                currentNodes.map((current) => {
                    const updated = updatedNodes.find((n) => n.id === current.id);
                    if (!updated) return current;
                    if (streamingNodeIds.includes(current.id)) {
                        return { ...current, data: updated.data, style: updated.style };
                    }
                    return current;
                })
            );
        }
    }, [streamingNodes]);

    // Simplified update effect
    useEffect(() => {
        const { nodes: newNodes, edges: newEdges } = parseWorkflow(workflowData);

        setNodes((currentNodes) => {
            if (currentNodes.length !== newNodes.length) return newNodes;

            return currentNodes.map((current) => {
                const updated = newNodes.find(n => n.id === current.id);
                if (!updated) return current;

                const hasChanged =
                    current.position.x !== updated.position.x ||
                    current.position.y !== updated.position.y ||
                    current.data.label !== updated.data.label ||
                    JSON.stringify(current.style) !== JSON.stringify(updated.style) ||
                    current.draggable !== updated.draggable;

                return hasChanged ? updated : current;
            });
        });
        setEdges(newEdges);

    }, [workflowData, parseWorkflow, setNodes, setEdges]);

    // Removed cleanup effect for animations

    const handleNodesChange = useCallback((changes: NodeChange[]) => {
        onNodesChange(changes);

        const dragStart = changes.find(
            (c) => c.type === 'position' && c.dragging === true
        );
        if (dragStart && "id" in dragStart && onNodeDragStart)
            onNodeDragStart(dragStart.id);

        const hasDragStop = changes.some(
            (change) => change.type === "position" && change.dragging === false,
        );

        if (hasDragStop) {
            const dragStopChange = changes.find(
                (c) => c.type === "position" && c.dragging === false,
            );
            const dragStopNodeId =
                dragStopChange && "id" in dragStopChange ? dragStopChange.id : null;

            if (isRemoteRef.current) {
                if (dragStopNodeId && onNodeDragStop) onNodeDragStop(dragStopNodeId);
                return;
            }

            if (workflowData) {
                setTimeout(() => {
                    setNodes((currentNodes) => {
                        try {
                            const workflow = JSON.parse(workflowData);
                            const updatedNodes = workflow.nodes.map((node: any) => {
                                const reactFlowNode = currentNodes.find((n: Node) => n.id === node.id);
                                return { ...node, position: reactFlowNode?.position || node.position };
                            });
                            const updatedWorkflow = { ...workflow, nodes: updatedNodes };
                            const workflowStr = JSON.stringify(updatedWorkflow);
                            if (workflowStr !== lastSavedDataRef.current && onPositionChange) {
                                onPositionChange(workflowStr);
                                lastSavedDataRef.current = workflowStr;
                            }
                            if (dragStopNodeId && onNodeDragStop) onNodeDragStop(dragStopNodeId);
                        } catch (error) {
                            console.error("Failed to save positions:", error);
                            if (dragStopNodeId && onNodeDragStop) onNodeDragStop(dragStopNodeId);
                        }
                        return currentNodes;
                    });
                }, 0);
            } else {
                if (dragStopNodeId && onNodeDragStop) onNodeDragStop(dragStopNodeId);
            }
        }
    }, [onNodesChange, workflowData, setNodes, onPositionChange, onNodeDragStart, onNodeDragStop]);

    if (!workflowData) {
        return (
            <div className={styles.container}>
                <div className={styles.emptyState}>
                    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                        <path d="M10 6.5h4M10 17.5h4M6.5 10v4M17.5 10v4" />
                    </svg>
                    <h3>Workflow Visualization</h3>
                    <p>Ask the AI Chabot to create a workflow and it will be visualized over here</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.flowContainer}>
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={onEdgesChange}
                    fitView
                    attributionPosition="bottom-left"
                    defaultEdgeOptions={{
                        type: 'smoothstep',
                        animated: true,
                        style: { strokeWidth: 2 },
                    }}
                    connectionLineStyle={{ strokeWidth: 2, stroke: '#667eea' }}
                    snapToGrid={true}
                    snapGrid={[15, 15]}
                    elevateEdgesOnSelect={true}
                    minZoom={0.2}
                    maxZoom={4}
                    nodesDraggable={true}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    fitViewOptions={{ padding: 0.3 }}
                >
                    <Controls />
                    <MiniMap
                        style={{ background: '#f5f5f5' }}
                        nodeColor={(node) => {
                            const bgColor = node.style?.background as string;
                            return bgColor || '#667eea';
                        }}
                    />
                    <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
                </ReactFlow>
            </div>
        </div>
    );
}
