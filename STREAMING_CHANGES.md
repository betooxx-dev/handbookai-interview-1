# Streaming AI Responses — Resumen de Cambios

> Fecha: 16 de febrero de 2026
> Estado: Implementado, pendiente de pruebas end-to-end

---

## Qué se implementó

Streaming de respuestas de IA en tiempo real a través de WebSocket, con:

- Texto del chat aparece token por token (como ChatGPT)
- Nodos del workflow se actualizan en vivo durante el streaming
- Bloqueo de input para todos los usuarios mientras la IA responde
- Bloqueo visual de nodos seleccionados durante la actualización
- Selección de nodos en ReactFlow (click / Shift+Click) para indicar qué nodos modificar

---

## Archivos nuevos (4)

| Archivo | Propósito |
|---------|-----------|
| `backend/prompts/__init__.py` | Loader que carga los prompts desde archivos `.md` |
| `backend/prompts/workflow_base.md` | System prompt para la ruta HTTP (sin colaboración) |
| `backend/prompts/workflow_streaming.md` | System prompt para streaming con delimitadores `NODE_START/END` y 3 few-shot examples |
| `backend/services/stream_parser.py` | Máquina de estados que parsea tokens del stream de OpenAI en tiempo real |

## Archivos modificados (12)

### Backend (5)

| Archivo | Cambios |
|---------|---------|
| `backend/services/workflow_service.py` | Prompts movidos a archivos `.md`. Nuevos métodos: `stream_ai_response()`, `save_streamed_ai_message()`, `apply_node_updates_to_workflow()` |
| `backend/services/collaboration_manager.py` | Nuevos métodos: `broadcast_all()`, `lock_nodes_for_ai()`, `unlock_nodes_for_ai()`, `get_other_users_locked_nodes()` |
| `backend/routes/collaboration_routes.py` | Nueva función `_handle_streaming_chat_message()` que orquesta el flujo completo de 9 pasos. El handler `chat_message` del WebSocket ahora acepta `selected_node_ids` |
| `backend/database.py` | Sin cambios funcionales (solo formato) |
| `backend/models/chat.py` | Sin cambios funcionales (solo formato) |

### Frontend (7)

| Archivo | Cambios |
|---------|---------|
| `frontend/src/types/index.ts` | Nuevos tipos: `inputLocked`, `inputLockedBy`, `streamingMessage`, `streamingNodes`, `onSelectionChange`. 9 nuevos callbacks de streaming en `CollaborationCallbacks` |
| `frontend/src/hooks/useCollaboration.ts` | Nuevo estado: `inputLocked`, `inputLockedBy`, `streamingMessage`, `streamingNodes`. Handlers para 9 nuevos eventos WebSocket. `sendChatMessage` ahora acepta `selectedNodeIds` |
| `frontend/src/app/page.tsx` | Conecta selección de nodos, streaming, y bloqueo de input entre componentes. Nuevos callbacks `onNodeStreamDone`, `onAiStreamDone`, `onSelectionChange` |
| `frontend/src/components/ChatWindow/ChatWindow.tsx` | Burbuja de streaming con cursor parpadeante, banner de input bloqueado, indicador de nodos seleccionados, placeholder dinámico |
| `frontend/src/components/ChatWindow/styles.module.css` | Estilos: `.streamCursor`, `.inputLockedBanner`, `.selectedNodesBadge` |
| `frontend/src/components/WorkflowVisualization/WorkflowVisualization.tsx` | Selección de nodos con `onNodeClick` + `onPaneClick` (Shift+Click para multi-select). Nodos en streaming con parsing parcial de JSON para actualizar labels en vivo. Efecto visual de glow/pulso |
| `frontend/src/components/WorkflowVisualization/styles.module.css` | Estilos: `.streamingNode` (animación de pulso), `.selectionBadge`, `.selectionHint` |

---

## Flujo de eventos (secuencia completa)

```
1. Usuario selecciona nodos 2 y 5 en ReactFlow (click + Shift+Click)
2. Usuario escribe "Haz estos nodos pasos de validación" y envía
3. Frontend envía: { type: "chat_message", content: "...", selected_node_ids: ["2", "5"] }
4. Backend → broadcast input_locked → todos los inputs se deshabilitan
5. Backend → broadcast nodes_locked → nodos 2 y 5 se marcan visualmente como bloqueados
6. Backend → guarda mensaje del usuario en DB
7. Backend → llama a OpenAI con stream=True y el STREAMING prompt
8. StreamParser procesa tokens:
   - Texto normal → broadcast ai_stream_delta → chat muestra texto progresivamente
   - ---NODE_START:2--- → broadcast node_stream_start → nodo 2 empieza a brillar
   - JSON del nodo → broadcast node_stream_delta → label del nodo se actualiza en vivo
   - ---NODE_END:2--- → broadcast node_stream_done → nodo 2 muestra estado final, se guarda en DB
   - Repite para nodo 5
9. Stream termina → guarda mensaje completo de IA en DB
10. Backend → broadcast ai_stream_done → mensaje final en el chat
11. Backend → broadcast nodes_unlocked → nodos editables de nuevo
12. Backend → broadcast input_unlocked → todos pueden escribir
```

## Fallback (cuando el LLM no usa delimitadores)

Si GPT-4o-mini no usa el formato `---NODE_START/END---` y responde con JSON embebido en texto (formato antiguo):

1. El StreamParser emite todo como `ai_stream_delta` → el texto se muestra progresivamente en el chat
2. Al terminar el stream, `_handle_streaming_chat_message` detecta que `parser.completed_nodes` está vacío
3. Usa `WorkflowService._extract_json_workflow()` como fallback para extraer el JSON del texto completo
4. El workflow se actualiza al final del stream (no en vivo, pero funciona)

---

## Eventos WebSocket nuevos

| Evento | Dirección | Propósito |
|--------|-----------|-----------|
| `input_locked` | Server → All | Deshabilitar input de todos |
| `input_unlocked` | Server → All | Habilitar input de todos |
| `nodes_locked` | Server → All | Bloquear nodos seleccionados visualmente |
| `nodes_unlocked` | Server → All | Desbloquear nodos |
| `ai_stream_delta` | Server → All | Token de texto para el chat |
| `ai_stream_done` | Server → All | Mensaje final completo de la IA |
| `node_stream_start` | Server → All | Un nodo empieza a actualizarse |
| `node_stream_delta` | Server → All | Token de JSON para un nodo |
| `node_stream_done` | Server → All | Nodo terminó de actualizarse |

---

## Pendiente / Para probar

- [ ] Reiniciar backend y frontend y probar flujo completo en modo colaboración
- [ ] Verificar que el prompt de streaming (`workflow_streaming.md`) hace que GPT-4o-mini use los delimitadores consistentemente
- [ ] Si el LLM sigue sin usar delimitadores, considerar subir a `gpt-4o` que sigue instrucciones de formato mejor
- [ ] Probar selección de nodos: click simple, Shift+Click multi-select, click en fondo para deseleccionar
- [ ] Probar que el fallback (extracción JSON del texto) funcione cuando no hay delimitadores
- [ ] Probar desconexión de usuario durante streaming (debe auto-desbloquear nodos e input)
- [ ] Probar error de OpenAI durante streaming (debe desbloquear todo y mostrar error)
- [ ] Considerar implementar streaming también para el modo sin colaboración (actualmente solo funciona vía WebSocket en modo colaboración)

---

## Cómo probar

1. Iniciar backend: `cd backend && uvicorn main:app --reload`
2. Iniciar frontend: `cd frontend && npm run dev`
3. Abrir dos ventanas del navegador, loguearse con usuarios distintos
4. Crear un chat y una sesión de colaboración
5. Ambos usuarios se unen a la sesión
6. En ReactFlow, hacer click en un nodo (debe aparecer borde azul y badge "1 node selected")
7. Escribir un mensaje pidiendo cambiar ese nodo y enviar
8. Verificar: input se bloquea, texto aparece progresivamente, nodo se actualiza, todo se desbloquea al final
