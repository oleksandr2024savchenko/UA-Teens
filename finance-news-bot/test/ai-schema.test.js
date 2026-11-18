import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { TriageSchema, AnalysisSchema, DeepSchema, DigestSchema } from '../src/ai.js';
import { sampleAnalysis } from './fixtures/sample.js';

test('усі схеми конвертуються у JSON Schema для structured outputs', () => {
  for (const s of [TriageSchema, AnalysisSchema, DeepSchema, DigestSchema]) {
    const f = betaZodOutputFormat(s);
    assert.equal(f.type, 'json_schema');
    assert.equal(f.schema.type, 'object');
    assert.equal(f.schema.additionalProperties, false);
  }
});

test('зразковий аналіз відповідає схемі', () => {
  assert.ok(AnalysisSchema.safeParse(sampleAnalysis).success);
});
