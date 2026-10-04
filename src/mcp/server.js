// =============================================================================
// Agent-Nexus MCP Server Transport
// =============================================================================

import { ValidationError } from '../domain/errors.js';

export const NEXUS_TOOLS = [
  {
    name: 'nexus_declare_intent',
    description: 'Declare your work intent and resource claims (files, modules, symbols) before making code edits. Nexus will check for conflicts and grant a lease or place you in waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID (provider-session)' },
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        summary: { type: 'string', description: 'Brief human-readable summary of what you are about to do' },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['file', 'module', 'symbol'] },
              target: { type: 'string', description: 'File path, module folder, or symbol name' }
            },
            required: ['type', 'target']
          },
          description: 'List of resources you plan to touch'
        },
        ttl_seconds: { type: 'number', description: 'Lease TTL in seconds (default 300)' }
      },
      required: ['agent_id', 'summary', 'claims']
    }
  },
  {
    name: 'nexus_release_lease',
    description: 'Release a held lease upon finishing or aborting your task. This triggers automatic wake-up for waiting sibling agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        lease_id: { type: 'string', description: 'Lease ID or Intent ID to release' },
        project_id: { type: 'string', description: 'Project ID' }
      },
      required: ['agent_id', 'lease_id']
    }
  },
  {
    name: 'nexus_state',
    description: 'Shared namespaced Key-Value store with atomic CAS (Compare-And-Swap) support.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list', 'cas'] },
        namespace: { type: 'string', description: 'Namespace (default "default")' },
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        key: { type: 'string' },
        value: { type: 'string' },
        expected: { type: ['string', 'null'], description: 'Expected current value for CAS' },
        new_value: { type: 'string', description: 'New value for CAS' },
        ttl_seconds: { type: 'number' }
      },
      required: ['action']
    }
  },
  {
    name: 'nexus_message',
    description: 'Send a coordination message or notify other agents working on the same workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Your agent ID' },
        to: { type: 'string', description: 'Target agent ID (omit for broadcast)' },
        content: { type: 'string', description: 'Message body' },
        importance: { type: 'string', enum: ['normal', 'urgent'], default: 'normal' },
        project_id: { type: 'string', description: 'Project ID (default "default")' }
      },
      required: ['from', 'content']
    }
  },
  {
    name: 'nexus_status',
    description: 'Query current coordinator snapshot: active agents, claims, locks, and timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID (optional)' }
      }
    }
  }
];

export const NEXUS_PROJECT_TOOLS = [
  {
    name: 'nexus_onboard',
    description: 'Onboard with the Project Lead before planning code edits. Register your planned work to receive conflict-free sequencing advice, safe construction corridors, and estimated wait times.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID (provider-session)' },
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        planned_work: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['file', 'module', 'symbol'] },
              target: { type: 'string', description: 'Planned target path or symbol' }
            },
            required: ['target']
          },
          description: 'List of files/modules you intend to modify in this session'
        },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional capability tags'
        }
      },
      required: ['agent_id', 'planned_work']
    }
  },
  {
    name: 'nexus_advise_plan',
    description: 'Re-evaluate your work plan against current project locks and get updated sequencing advice.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        planned_work: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['file', 'module', 'symbol'] },
              target: { type: 'string' }
            },
            required: ['target']
          }
        }
      },
      required: ['agent_id', 'planned_work']
    }
  },
  {
    name: 'nexus_report_milestone',
    description: 'Report a completed milestone or phase. Optionally release held leases and notify waiting sibling agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Your agent ID' },
        project_id: { type: 'string', description: 'Project ID (default "default")' },
        description: { type: 'string', description: 'Milestone summary' },
        lease_id_to_release: { type: 'string', description: 'Optional lease ID to release upon milestone' }
      },
      required: ['agent_id', 'description']
    }
  }
];

export const ALL_NEXUS_TOOLS = [...NEXUS_TOOLS, ...NEXUS_PROJECT_TOOLS];

export function handleMcpTool(toolName, args, { coordinator, stateService, messageService, projectRegistry = null }) {
  const pid = args?.project_id || 'default';

  if (toolName === 'nexus_onboard') {
    if (!projectRegistry) throw new Error('ProjectRegistry not initialized');
    const lead = projectRegistry.getOrCreateLead(pid);
    return lead.onboard({
      agentId: args.agent_id,
      plannedWork: args.planned_work || [],
      capabilities: args.capabilities || []
    });
  }

  if (toolName === 'nexus_advise_plan') {
    if (!projectRegistry) throw new Error('ProjectRegistry not initialized');
    const lead = projectRegistry.getOrCreateLead(pid);
    return lead.advisePlan({
      agentId: args.agent_id,
      plannedWork: args.planned_work || []
    });
  }

  if (toolName === 'nexus_report_milestone') {
    let releaseResult = null;
    if (args.lease_id_to_release) {
      releaseResult = coordinator.releaseLease(args.lease_id_to_release, args.agent_id);
    }
    coordinator.logActivity(args.agent_id, 'milestone:reported', null, `Milestone reached: ${args.description}`, pid);
    return {
      success: true,
      milestone: args.description,
      released: releaseResult
    };
  }

  if (toolName === 'nexus_declare_intent') {
    return coordinator.declareIntent({
      agentId: args.agent_id,
      intentSummary: args.summary,
      claims: args.claims,
      ttlSeconds: args.ttl_seconds || 300,
      projectId: pid
    });
  }

  if (toolName === 'nexus_release_lease') {
    return coordinator.releaseLease(args.lease_id, args.agent_id);
  }

  if (toolName === 'nexus_state') {
    const ns = args.namespace || 'default';
    if (args.action === 'get') return stateService.get(ns, args.key, pid);
    if (args.action === 'set') return stateService.set(ns, args.key, args.value, args.updated_by || 'agent', args.ttl_seconds, pid);
    if (args.action === 'delete') return { success: stateService.delete(ns, args.key, pid) };
    if (args.action === 'list') return stateService.list(ns, args.prefix || '', pid);
    if (args.action === 'cas') return stateService.compareAndSwap(ns, args.key, args.expected, args.new_value, args.updated_by || 'agent', args.ttl_seconds, pid);
    throw new ValidationError(`Unsupported action "${args.action}" for nexus_state`, 'action');
  }

  if (toolName === 'nexus_message') {
    return messageService.send({
      from: args.from,
      to: args.to || null,
      content: args.content,
      importance: args.importance || 'normal',
      projectId: pid
    });
  }

  if (toolName === 'nexus_status') {
    return coordinator.getDashboardSnapshot(args.project_id || null);
  }

  throw new Error(`Unknown Nexus MCP tool: ${toolName}`);
}
