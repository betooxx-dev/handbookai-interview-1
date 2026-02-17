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

type NodeEffect = 'added' | 'updated' | 'removed';

function diffNodes(
    prevMap: Map<string, NodeSnapshot>,
    newMap: Map<string, NodeSnapshot>,
): Record<string, NodeEffect> {
    const effects: Record<string, NodeEffect> = {};
    newMap.forEach((data, id) => {
        const prev = prevMap.get(id);
        if (!prev) {
            effects[id] = 'added';
        } else if (prev.label !== data.label || prev.type !== data.type) {
            effects[id] = 'updated';
        }
    });
    prevMap.forEach((_, id) => {
        if (!newMap.has(id)) {
            effects[id] = 'removed';
        }
    });
    return effects;
}

const EFFECT_CLASS_MAP: Record<NodeEffect, string | undefined> = {
    added: styles.nodeAdded,
    updated: styles.nodeUpdated,
    removed: styles.nodeRemoved,
};

/** Override inline styles that would conflict with CSS animations */
function applyEffectToNode(node: Node, effect: NodeEffect | undefined): Node {
    if (!effect) return node;
    const cls = EFFECT_CLASS_MAP[effect];
    if (!cls) return node;

    if (effect === 'added' || effect === 'removed') {
        // These animations control opacity and transform — remove conflicting inline props
        const { opacity, transition, transform, ...restStyle } = (node.style || {}) as Record<string, any>;
        return { ...node, className: cls, style: { ...restStyle, transition: 'none' } };
    }
    // 'updated' only uses box-shadow — no conflicts with inline styles
    return { ...node, className: cls };
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
    const animationRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const effectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Track previous state for diffing
    const prevWorkflowDataRef = useRef<string | null>(null);
    const justSwitchedChatRef = useRef(false);
    const prevChatIdRef = useRef<number | null>(null);

    // Detect chat switches to avoid full reveal on load
    useEffect(() => {
        if (chatId !== prevChatIdRef.current) {
            prevChatIdRef.current = chatId;
            justSwitchedChatRef.current = true;
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

            // Show orphaned nodes (no edges) at the bottom so they're never invisible
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
                    const accumulated = streamingNodes[node.id];
                    if (accumulated.trim()) {
                        displayLabel = accumulated.trim();
                    }
                }

                let labelContent = displayLabel;
                if (isLocked) {
                    labelContent = `\uD83D\uDD12 ${displayLabel} (${lockedNodes[node.id].username})`;
                }
                if (displayDescription && !isStreamingNode) {
                    labelContent = `${displayLabel}\n${displayDescription}`;
                    if (isLocked) {
                        labelContent = `\uD83D\uDD12 ${displayLabel} (${lockedNodes[node.id].username})\n${displayDescription}`;
                    }
                }

                const getNodeBackground = () => {
                    if (isLocked) return '#6b7280';
                    if (isStreamingNode) return undefined;
                    switch (node.type) {
                        case 'start': return '#FC005C';
                        case 'end': return '#667eea';
                        case 'decision': return '#f6ad55';
                        default: return '#48bb78';
                    }
                };

                const getNodeBorder = () => {
                    if (isLocked) return '2px solid #ef4444';
                    if (isStreamingNode) return '2px solid #667eea';
                    return 'none';
                };

                return {
                    id: node.id,
                    type: 'default',
                    data: { label: labelContent },
                    position,
                    draggable: !isLocked,
                    className: isStreamingNode ? styles.streamingNode : undefined,
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
                        boxShadow: isStreamingNode
                            ? '0 0 15px rgba(102, 126, 234, 0.5)'
                            : undefined,
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

    // Re-parse when streaming nodes change (live label updates)
    useEffect(() => {
        const streamingNodeIds = Object.keys(streamingNodes);
        if (streamingNodeIds.length > 0) {
            const { nodes: updatedNodes } = parseWorkflow(workflowData);
            setNodes((currentNodes) =>
                currentNodes.map((current) => {
                    const updated = updatedNodes.find((n) => n.id === current.id);
                    if (!updated) return current;
                    if (streamingNodeIds.includes(current.id)) {
                        return { ...current, data: updated.data, style: updated.style, className: updated.className };
                    }
                    return current;
                })
            );
        }
    }, [streamingNodes]);

    // ── Main animation / diff effect ─────────────────────────
    useEffect(() => {
        if (animationRef.current) {
            clearInterval(animationRef.current);
            animationRef.current = null;
        }
        if (effectTimeoutRef.current) {
            clearTimeout(effectTimeoutRef.current);
            effectTimeoutRef.current = null;
        }

        const prevData = prevWorkflowDataRef.current;
        prevWorkflowDataRef.current = workflowData;

        const prevMap = extractNodeMap(prevData);
        const newMap = extractNodeMap(workflowData);
        const { nodes: newNodes, edges: newEdges } = parseWorkflow(workflowData);

        // Determine what kind of transition this is
        const isFirstCreation = prevMap.size === 0 && newMap.size > 0 && !justSwitchedChatRef.current;
        justSwitchedChatRef.current = false;

        let startTimer: ReturnType<typeof setTimeout> | null = null;

        if (isFirstCreation && newNodes.length > 1) {
            // ── Full sequential reveal (only for brand new workflows) ──
            const hiddenNodes = newNodes.map((n) => ({
                ...n,
                style: { ...n.style, opacity: 0, transition: 'opacity 0.3s ease-out' },
            }));
            setNodes(hiddenNodes);
            setEdges([]);

            let visibleCount = 0;
            const revealNext = () => {
                visibleCount++;
                const updatedNodes = newNodes.map((n, idx) => ({
                    ...n,
                    style: {
                        ...n.style,
                        opacity: idx < visibleCount
                            ? (typeof n.style?.opacity === 'number' ? n.style.opacity : 1)
                            : 0,
                        transition: 'opacity 0.3s ease-out',
                    },
                }));
                const visibleNodeIds = new Set(newNodes.slice(0, visibleCount).map((n) => n.id));
                const visibleEdges = newEdges.filter(
                    (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
                );
                setNodes(updatedNodes);
                setEdges(visibleEdges);
                if (visibleCount >= newNodes.length && animationRef.current) {
                    clearInterval(animationRef.current);
                    animationRef.current = null;
                }
            };

            startTimer = setTimeout(() => {
                revealNext();
                if (newNodes.length > 1) {
                    animationRef.current = setInterval(revealNext, 150);
                }
            }, 100);
        } else {
            // ── Incremental update: per-node diff ──
            const effects = diffNodes(prevMap, newMap);
            const removedIds = Object.entries(effects)
                .filter(([, e]) => e === 'removed')
                .map(([id]) => id);
            const hasVisualEffects = Object.keys(effects).length > 0;

            if (removedIds.length > 0) {
                // Phase 1: animate removed nodes out (clear conflicting inline styles)
                setNodes((prev) => prev.map((n) =>
                    removedIds.includes(n.id)
                        ? applyEffectToNode(n, 'removed')
                        : n
                ));
                setEdges((prev) => prev.filter(
                    (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)
                ));

                // Phase 2: after fade-out, swap to new nodes (with add/update effects)
                startTimer = setTimeout(() => {
                    const effectNodes = newNodes.map((n) =>
                        effects[n.id] ? applyEffectToNode(n, effects[n.id]) : n
                    );
                    setNodes(effectNodes);
                    setEdges(newEdges);

                    // Phase 3: clear effect classes
                    effectTimeoutRef.current = setTimeout(() => {
                        setNodes((prev) => prev.map((n) => ({
                            ...n,
                            className: streamingNodes[n.id] !== undefined ? styles.streamingNode : undefined,
                        })));
                    }, 1200);
                }, 500);
            } else {
                // No removals — apply add/update effects directly
                setNodes((currentNodes) => {
                    if (currentNodes.length !== newNodes.length) {
                        return newNodes.map((n) =>
                            effects[n.id] ? applyEffectToNode(n, effects[n.id]) : n
                        );
                    }
                    return currentNodes.map((current) => {
                        const updated = newNodes.find((n) => n.id === current.id);
                        if (!updated) return current;

                        const effect = effects[current.id];
                        const target = effect ? applyEffectToNode(updated, effect) : updated;
                        const posChanged = current.position.x !== target.position.x || current.position.y !== target.position.y;
                        const labelChanged = current.data?.label !== target.data?.label;
                        const styleChanged =
                            current.style?.opacity !== target.style?.opacity ||
                            current.style?.background !== target.style?.background ||
                            current.style?.border !== target.style?.border ||
                            current.style?.boxShadow !== target.style?.boxShadow;
                        const classChanged = current.className !== target.className;
                        const draggableChanged = current.draggable !== target.draggable;
                        if (!posChanged && !labelChanged && !styleChanged && !classChanged && !draggableChanged) {
                            return current;
                        }
                        return target;
                    });
                });
                setEdges(newEdges);

                // Clear effect classes after animation
                if (hasVisualEffects) {
                    effectTimeoutRef.current = setTimeout(() => {
                        setNodes((prev) => prev.map((n) => {
                            if (effects[n.id]) {
                                return {
                                    ...n,
                                    className: streamingNodes[n.id] !== undefined ? styles.streamingNode : undefined,
                                };
                            }
                            return n;
                        }));
                    }, 1200);
                }
            }
        }

        return () => {
            if (startTimer) clearTimeout(startTimer);
            if (animationRef.current) {
                clearInterval(animationRef.current);
                animationRef.current = null;
            }
        };
    }, [workflowData, parseWorkflow, setNodes, setEdges]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (animationRef.current) clearInterval(animationRef.current);
            if (effectTimeoutRef.current) clearTimeout(effectTimeoutRef.current);
        };
    }, []);

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
