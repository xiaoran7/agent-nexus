import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { NEXUS_TOOLS, handleMcpTool } from '../src/mcp/server.js';
import { createDatabase } from '../src/storage/database.js';

async function runComprehensiveTests() {
  console.log('====================================================');
  console.log('  Agent-Nexus Comprehensive Verification Test Suite  ');
  console.log('====================================================\n');

  const db = createDatabase(':memory:');
  const eventBus = new EventEmitter();
  const coordinator = new CoordinatorEngine(db, eventBus);
  const stateService = new StateService(db, eventBus);
  const messageService = new MessageService(db, eventBus);

  // 预先注册 Agent
  coordinator.registerAgent({ id: 'codex-1', name: 'Codex 1', provider: 'codex', sessionId: 's1' });
  coordinator.registerAgent({ id: 'claude-2', name: 'Claude 2', provider: 'claude', sessionId: 's2' });

  // ----------------------------------------------------
  // Test 1: Agent-Comm 对齐能力 (Shared State & CAS)
  // ----------------------------------------------------
  console.log('1. Testing State Service & CAS (Compare-And-Swap)...');
  stateService.set('locks', 'playwright-port', '8080', 'agent-1', 60);
  const lock = stateService.get('locks', 'playwright-port');
  assert.strictEqual(lock.value, '8080');

  // 模拟 CAS 成功 (8080 -> 8081)
  const casSuccess = stateService.compareAndSwap('locks', 'playwright-port', '8080', '8081', 'agent-2');
  assert.strictEqual(casSuccess.swapped, true);
  assert.strictEqual(stateService.get('locks', 'playwright-port').value, '8081');

  // 模拟 CAS 竞争失败 (期望原值依然是 8080，但实际已是 8081)
  const casFail = stateService.compareAndSwap('locks', 'playwright-port', '8080', '9999', 'agent-3');
  assert.strictEqual(casFail.swapped, false);
  console.log(' -> State & CAS tests passed.');

  // ----------------------------------------------------
  // Test 2: Agent-Comm 对齐能力 (Coordination Messaging)
  // ----------------------------------------------------
  console.log('2. Testing Messaging Bus (Direct & Inbox)...');
  messageService.send({
    from: 'codex-1',
    to: 'claude-2',
    content: 'InteractionResolver refactoring completed. Please rebase.',
    importance: 'urgent'
  });
  const inbox = messageService.inbox('claude-2');
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].importance, 'urgent');
  assert.strictEqual(inbox[0].from_agent, 'codex-1');
  console.log(' -> Messaging Bus passed.');

  // ----------------------------------------------------
  // Test 3: MCP Protocol Tools 映射与执行
  // ----------------------------------------------------
  console.log('3. Testing MCP Tools mapping...');
  assert.strictEqual(NEXUS_TOOLS.length, 5);

  coordinator.registerAgent({ id: 'claude-mcp', name: 'Claude MCP', provider: 'claude', sessionId: 'smcp' });
  const mcpDeclare = handleMcpTool('nexus_declare_intent', {
    agent_id: 'claude-mcp',
    summary: 'Testing via MCP tool',
    claims: [{ type: 'symbol', target: 'doAnalysis' }]
  }, { coordinator, stateService, messageService });
  assert.strictEqual(mcpDeclare.status, 'GRANTED');

  const mcpStatus = handleMcpTool('nexus_status', {}, { coordinator, stateService, messageService });
  assert(mcpStatus.agents.length >= 1);
  console.log(' -> MCP Tools mapping passed.');

  // ----------------------------------------------------
  // Test 4: Coordinator 确定性三级冲突与等待唤醒
  // ----------------------------------------------------
  console.log('4. Testing 3-tier Conflict Detection & Wakeup Queue...');
  coordinator.registerAgent({ id: 'a1', name: 'Agent 1', provider: 'codex', sessionId: 's1' });
  coordinator.registerAgent({ id: 'a2', name: 'Agent 2', provider: 'claude', sessionId: 's2' });

  // A1 claim module
  const claimA1 = coordinator.declareIntent({
    agentId: 'a1',
    intentSummary: 'Refactoring network module',
    claims: [{ type: 'module', target: 'src/network' }]
  });
  assert.strictEqual(claimA1.status, 'GRANTED');

  // A2 claim file under network module -> Module Conflict!
  const claimA2 = coordinator.declareIntent({
    agentId: 'a2',
    intentSummary: 'Adding retry to http client',
    claims: [{ type: 'file', target: 'src/network/client.ts' }]
  });
  assert.strictEqual(claimA2.status, 'WAITING');
  assert.strictEqual(claimA2.blockedBy, 'a1');
  console.log(' -> Module-file hierarchy conflict correctly detected!');

  // Release A1 -> A2 woken up
  let wokenAgent = null;
  eventBus.once('agent:woken', (e) => wokenAgent = e.agent_id);
  coordinator.releaseLease(claimA1.leaseId, 'a1');
  assert.strictEqual(wokenAgent, 'a2');
  console.log(' -> Release & Waiter Wakeup passed.');

  console.log('\n====================================================');
  console.log('  ✅ ALL TESTS (COMM + COORDINATOR + MCP) PASSED!     ');
  console.log('====================================================\n');
}

runComprehensiveTests();
