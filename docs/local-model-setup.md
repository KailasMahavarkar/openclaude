# Local Model Setup

OpenClaude can run entirely against a model on your own GPU — no API key, no rate limit,
no data leaving the machine — through the same OpenAI-compatible provider path it uses
for Ollama and LiteLLM.

## Overview

Any local server that speaks the OpenAI API works: `llama-server` (llama.cpp), vLLM, or
LM Studio. You point `OPENAI_BASE_URL` at it and OpenClaude treats it like any other
provider. Nothing needs to be compiled into OpenClaude.

Two topologies, both supported:

```
direct     OpenClaude ──► llama-server :8081/v1
via Gratis OpenClaude ──► Gratis :3460/v1 ──► llama-server :8081/v1
                                       └────► cloud free tiers (fallback)
```

Direct is the simplest. Routing through [Gratis](https://github.com/orkait/gratis) adds
automatic fallback to cloud free tiers when the local box is busy or off, plus one
endpoint that covers both.

## Prerequisites

- A local OpenAI-compatible server running (see below)
- Enough VRAM for the model you pick

## 1. Start a local server

With llama.cpp's `llama-server`, the flags that matter on consumer GPUs:

```bash
llama-server \
  -m /path/to/model.gguf \
  -ngl 999 -fa on \
  -c 65536 -ctk q4_0 -ctv q4_0 \
  -ub 128 -np 1 \
  --host 127.0.0.1 --port 8081
```

| Flag | Why |
|---|---|
| `-ngl 999` | put every layer on the GPU |
| `-fa on` | flash attention — bounds the attention buffer at long context |
| `-ctk/-ctv q4_0` | 4-bit KV cache, roughly 4x cheaper than fp16; this is what makes long context fit in consumer VRAM |
| `-ub 128` | small micro-batch keeps the logits buffer bounded — large-vocabulary models OOM at the default |
| `-np 1` | single slot; a coding agent is one stream, and parallel slots split the KV budget |

Verify it is up before pointing anything at it:

```bash
curl -s http://127.0.0.1:8081/v1/models
```

## 2. Point OpenClaude at it

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8081/v1
export OPENAI_API_KEY=local   # llama-server ignores it unless started with --api-key,
                              # but the client requires a non-empty value
openclaude --model <model-name-from-/v1/models>
```

The model name must match what `/v1/models` reports — for `llama-server` that is
typically the GGUF filename.

One-shot check:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8081/v1 OPENAI_API_KEY=local \
  openclaude -p "Reply with exactly: local ok" --model <model-name>
```

## 3. Optional — route through Gratis instead

If you already run Gratis, it exposes local *and* cloud free models behind one endpoint,
with the local one preferred when it is up:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3460/v1
export OPENAI_API_KEY=$LOCAL_API_KEY   # only if Gratis has one set
openclaude --model local/<model-name>
```

Gratis discovers the local server from `LOCAL_LLM_BASE_URL` and skips it silently when
nothing is listening, so the same command keeps working with the GPU box off.

## Choosing context vs speed

Local VRAM is a fixed budget shared between weights, KV cache, and compute. Two things
worth knowing before you pick a context size:

- **Decode speed is roughly flat across context length.** Long context costs VRAM, not
  tokens/sec — the decode is bound by weight bandwidth, not by how full the KV cache is.
- **Speculative decoding trades VRAM for speed.** A drafter model is lossless (the target
  verifies every drafted token, so output is unchanged) but its weights come out of the
  same budget that would otherwise buy context.

Measure your own ceiling rather than guessing: start at a modest context, confirm it
loads, then step up until allocation fails.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `failed to allocate ... buffer` at startup | context or micro-batch too large for free VRAM — lower `-c`, or `-ub` |
| Model list empty | server not running, or `OPENAI_BASE_URL` missing the `/v1` suffix |
| `model not found` | the `--model` value must match `/v1/models` exactly |
| Very slow first token | the model is loading; large GGUFs take a moment to page in |
