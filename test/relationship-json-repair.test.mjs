// relationship-pilot 影子评估的 JSON 容错测试（Issue #6 ③）。
// 评估模型的 tool call arguments 带常见瑕疵时应能修复解析；彻底坏掉仍抛错。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseRelationshipResponse } = await import('../src/pilots/relationship-pilot.js');

const EVIDENCE = [{ evidenceId: 'ev1', chatKey: 'group:1' }];
const responseWithArgs = (argumentsText) => ({
  message: {
    tool_calls: [{ function: { name: 'submit_relationship_events', arguments: argumentsText } }]
  }
});
const VALID = {
  events: [{ type: 'warm_exchange', strength: 0.5, confidence: 0.8, evidenceIds: ['ev1'], summary: '正常互动' }]
};

test('合法 JSON 照常解析（回归确认）', () => {
  const parsed = parseRelationshipResponse(
    responseWithArgs(JSON.stringify(VALID)),
    EVIDENCE
  );
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].type, 'warm_exchange');
});

test('瑕疵：代码围栏 + 尾随逗号 → 修复后解析', () => {
  const malformed = '```json\n{"events":[{"type":"warm_exchange","strength":0.5,"confidence":0.8,"evidenceIds":["ev1"],"summary":"围栏样本",},],}\n```';
  const parsed = parseRelationshipResponse(responseWithArgs(malformed), EVIDENCE);
  assert.equal(parsed.events[0].summary, '围栏样本');
});

test('瑕疵：单引号 → 修复后解析', () => {
  const malformed = "{'events':[{'type':'trust_signal','strength':0.3,'confidence':0.6,'evidenceIds':['ev1'],'summary':'单引号样本'}]}";
  const parsed = parseRelationshipResponse(responseWithArgs(malformed), EVIDENCE);
  assert.equal(parsed.events[0].type, 'trust_signal');
});

test('瑕疵：summary 里引用原话产生未转义引号（长输出高发形态）→ 修复后解析', () => {
  const malformed = '{"events":[{"type":"reciprocal_interest","strength":0.4,"confidence":0.7,"evidenceIds":["ev1"],"summary":"他说"改天一起打游戏"之后关系明显升温"}]}';
  const parsed = parseRelationshipResponse(responseWithArgs(malformed), EVIDENCE);
  assert.equal(parsed.events[0].summary, '他说"改天一起打游戏"之后关系明显升温');
});

test('彻底坏掉的 JSON：仍然抛错（不静默吞、不编造数据）', () => {
  assert.throws(
    () => parseRelationshipResponse(responseWithArgs('{"events":[{"type":"'), EVIDENCE),
    /关系评估工具参数不是有效 JSON/
  );
  assert.throws(
    () => parseRelationshipResponse(responseWithArgs('完全没有 JSON 的输出'), EVIDENCE),
    /关系评估工具参数不是有效 JSON/
  );
});

test('修复后内容仍要过完整校验（不能靠修复绕过事件规则）', () => {
  // 修复成功但 strength 越界：照样抛校验错误
  const malformed = '{"events":[{"type":"warm_exchange","strength":9,"confidence":0.8,"evidenceIds":["ev1"]}]}';
  assert.throws(
    () => parseRelationshipResponse(responseWithArgs(malformed), EVIDENCE),
    /strength 必须在 0 到 1/
  );
});
