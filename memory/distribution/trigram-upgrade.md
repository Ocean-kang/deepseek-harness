---
kind: upgrade-guide
description: "Upgrade memory recall and learning budgets for short queries, model paraphrases and separate display descriptions."
---

# Portable memory recall and learning

English | [中文](trigram-upgrade.zh.md)

## Change

Portable memory 0.1.8 uses `trigram` recall, including literal substring matching for one- and two-character terms. With no text hits and eligible records available, the portable default makes one recorded call to the existing L1 model to generate search paraphrases, then searches again. Text matches avoid this extra call. Model output cannot supply recall facts. Direct `textSearch: {}` retains `unicode61` and disables query expansion.

New L1–L3 tasks also make a separate model call to generate a one-sentence display description for each final memory. This call shares the extraction task's input, output and lifetime call budgets; failure prevents partial publication. L2/L3 select bounded existing knowledge and group original L0 evidence even within one source memory. A further model step merges checked candidates when needed. Optional `Knowledge.examinedEvents` records program-assigned references to the original events supplied during checking; final merges do not simultaneously reread every original event. `supported` remains a model judgment, not a factual guarantee.

Stored L0 events and memory versions stay intact. Old descriptions are optional and fall back to readable content. Retry retains the stored prompt version and uses bounded selection of optional existing knowledge; old v1/v2 tasks whose required ancestor chain exceeds budget need a new operation with current settings. New v3 requests omit ancestor summaries while the server retains their complete chain. A single required source or evidence event that exceeds the input budget still fails explicitly. Older plugin readers do not understand new task prompt versions; restore a pre-upgrade backup before downgrading.

## Migration

1. Stop processes using memory databases and back up complete database directories, including SQLite sidecars. Install `deepseek-ai-dsh-memory-l0-0.1.8.tgz` in the supported DSH Web profile and restart it. Storage ownership and activation rules stay as documented in [installation](README.md).
2. Keep omitted `textSearch` to enable portable short-term matching and model paraphrases. To retain text-only complete-word recall, apply this override to `memory-l0`, then restart:

```yaml
- id: memory-l0
  config:
    textSearch:
      tokenizer: unicode61
      expandQuery: false
```

3. To keep short-term matching without extra query calls, use `tokenizer: trigram` with `expandQuery: false`. With expansion enabled, `expansionTimeoutMs` defaults to 15000; malformed output or provider failure reports an error. Search still enforces query-term, candidate, result-count and rendered-byte limits.
4. Ensure `maxCalls` allows extraction, source merges, and one description call per final memory. Retry failed knowledge tasks through the existing retry API; exhausted lifetime call budgets require a new operation. Re-extract an old L1 or create a task with current settings to generate descriptions and original-evidence checks; history is not rewritten automatically.
5. Open Memory and verify descriptions and row-start checkboxes. Test a short query and a paraphrase, then inspect the committed context receipt. Auxiliary L0 records retain extraction, description and query-expansion requests and results; only stored authorized memories may enter recall.
