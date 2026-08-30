# JARVIS Local Intelligence Stack

## Active runtime

| Layer | Selection | Why |
| --- | --- | --- |
| Inference | llama.cpp CUDA, Qwen3 8B Q4_K_M | Best current fit for the RTX 5060 Ti 16 GB while leaving VRAM for desktop use |
| Orchestration | LangGraph + LangChain Core | Typed plan, risk-gate, and execution graph without a cloud dependency |
| Long-term memory | PostgreSQL 16 + pgvector HNSW | Already integrated with Command Center, household scoped, durable, and avoids a second database |
| Embeddings | all-MiniLM-L6-v2 through the local OpenAI-compatible embedding endpoint | Fast 384-dimensional CPU embeddings with no external API |
| Voice identity | Whisper service + local speaker encoder | Multi-sample per-user voiceprints and challenge-response login |
| Desktop tools | Electron isolated preload + typed IPC allowlist | Real Windows actions without exposing Node or an arbitrary shell to the renderer/model |

The local agent graph is `classify -> risk_gate -> planner`. The planner uses the same local Qwen endpoint and emits structured tool steps. High-risk and state-changing intents are approval-gated. The renderer cannot pass arbitrary executable paths or shell text.

## Deliberate exclusions

- LangSmith, Pinecone, OpenAI Embeddings, and LlamaParse are cloud services and conflict with this installation's all-local privacy requirement.
- Chroma, Milvus, and Qdrant duplicate the live pgvector memory store. Running them together would fragment retrieval and consume additional RAM.
- Ollama and vLLM are supported alternatives, but are not run concurrently with llama.cpp. Multiple inference servers would compete for the same 16 GB of VRAM.
- LlamaIndex is best introduced when document-library ingestion is added. The current semantic memory path is already mature and directly integrated with Command Center; adding a second retrieval abstraction now would create two sources of truth.
- Ragas and Phoenix belong in an offline evaluation/observability profile, not the always-on desktop startup path. They should never add latency to a voice turn.

## Next safe expansion

Add an opt-in knowledge-ingestion service that uses LlamaIndex + Unstructured to parse local documents into the existing pgvector database, then run Ragas evaluations and Phoenix tracing only on demand. Keep the live voice path independent so JARVIS stays fast and available.
