-- Per-document consent for sending this document's text to a hosted (cloud) LLM.
-- Off by default: a document's text only goes to a local model unless the user turns this on.
-- Retrieval for a hosted provider skips documents where it is false.
ALTER TABLE documents ADD COLUMN hosted_llm_allowed BOOLEAN NOT NULL DEFAULT false;
