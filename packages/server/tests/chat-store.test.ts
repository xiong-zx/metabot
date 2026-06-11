import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_FILE_STORAGE_ROOT,
  ChatForbiddenError,
  ChatStore,
  resolveChatFilePath,
} from '../src/chat/chat-store.js';
import { makeKit, type TestKit } from './helpers.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

describe('ChatStore', () => {
  it('resolves file storage keys under the configured /vepfs default root', () => {
    expect(resolveChatFilePath('runs/out.txt')).toBe(`${DEFAULT_CHAT_FILE_STORAGE_ROOT}/runs/out.txt`);
    expect(() => resolveChatFilePath('../secret.txt')).toThrow('bad_storage_key');
  });

  it('persists conversations, participants, messages, mentions, and read state', () => {
    kit = makeKit('chat-store');
    const store = new ChatStore(kit.db, kit.logger);

    const conv = store.createConversation({
      kind: 'group',
      title: 'Launch room',
      createdBy: 'alice@xvirobotics.com',
      participants: [
        { kind: 'user', ref: 'bob@xvirobotics.com', displayName: 'Bob' },
        { kind: 'agent', ref: 'metabot', displayName: 'MetaBot' },
      ],
    });

    expect(conv.kind).toBe('group');
    expect(conv.participants.map((p) => `${p.kind}:${p.ref}`).sort()).toEqual([
      'agent:metabot',
      'user:alice@xvirobotics.com',
      'user:bob@xvirobotics.com',
    ]);

    const msg = store.appendMessage({
      conversationId: conv.id,
      kind: 'user',
      senderKind: 'user',
      senderRef: 'alice@xvirobotics.com',
      content: 'please review',
      mentionedAgentRefs: [],
    });
    expect(msg.mentionedAgentRefs).toEqual([]);
    expect(msg.runId).toBeNull();

    const mentioned = store.appendMessage({
      conversationId: conv.id,
      kind: 'user',
      senderKind: 'user',
      senderRef: 'bob@xvirobotics.com',
      content: '@metabot review this',
      mentionedAgentRefs: ['metabot', 'metabot'],
    });
    expect(mentioned.mentionedAgentRefs).toEqual(['metabot']);

    const messages = store.listMessages(conv.id, 'alice@xvirobotics.com');
    expect(messages.map((m) => m.content)).toEqual(['please review', '@metabot review this']);

    const read = store.markRead(conv.id, 'alice@xvirobotics.com', mentioned.id);
    expect(read.lastReadMessageId).toBe(mentioned.id);
  });

  it('requires user membership for reads and user sends', () => {
    kit = makeKit('chat-store-acl');
    const store = new ChatStore(kit.db, kit.logger);
    const conv = store.createConversation({
      kind: 'dm',
      createdBy: 'alice@xvirobotics.com',
      participants: [{ kind: 'agent', ref: 'metabot' }],
    });

    expect(() => store.listMessages(conv.id, 'eve@xvirobotics.com')).toThrow(ChatForbiddenError);
    expect(() => store.appendMessage({
      conversationId: conv.id,
      kind: 'user',
      senderKind: 'user',
      senderRef: 'eve@xvirobotics.com',
      content: 'spoof',
    })).toThrow(ChatForbiddenError);
  });

  it('finds or creates a stable agent DM per user and agent', () => {
    kit = makeKit('chat-store-dm');
    const store = new ChatStore(kit.db, kit.logger);

    const first = store.findOrCreateAgentDm({
      userRef: 'alice@xvirobotics.com',
      agentRef: 'metabot',
      agentDisplayName: 'MetaBot',
    });
    const second = store.findOrCreateAgentDm({
      userRef: 'alice@xvirobotics.com',
      agentRef: 'metabot',
      agentDisplayName: 'MetaBot',
    });

    expect(second.id).toBe(first.id);
    expect(first.participants.map((p) => `${p.kind}:${p.ref}`).sort()).toEqual([
      'agent:metabot',
      'user:alice@xvirobotics.com',
    ]);
  });

  it('persists idempotent run events and writes complete output as assistant message', () => {
    kit = makeKit('chat-store-runs');
    const store = new ChatStore(kit.db, kit.logger);
    const conv = store.createConversation({
      kind: 'dm',
      createdBy: 'alice@xvirobotics.com',
      participants: [{ kind: 'agent', ref: 'metabot' }],
    });
    const trigger = store.appendMessage({
      conversationId: conv.id,
      kind: 'user',
      senderKind: 'user',
      senderRef: 'alice@xvirobotics.com',
      content: 'hello',
    });
    const run = store.createRun({
      conversationId: conv.id,
      triggerMessageId: trigger.id,
      targetAgentRef: 'metabot',
    });

    const first = store.appendRunEvent({
      runId: run.id,
      seq: 1,
      kind: 'state',
      payload: { status: 'running', text: 'thinking' },
    });
    const duplicate = store.appendRunEvent({
      runId: run.id,
      seq: 1,
      kind: 'state',
      payload: { status: 'running', text: 'thinking' },
    });
    expect(duplicate.id).toBe(first.id);
    expect(() => store.appendRunEvent({
      runId: run.id,
      seq: 1,
      kind: 'state',
      payload: { status: 'running', text: 'conflict' },
    })).toThrow('run_event_seq_conflict');

    store.appendRunEvent({
      runId: run.id,
      seq: 2,
      kind: 'complete',
      payload: { content: 'final answer' },
    });
    expect(() => store.appendRunEvent({
      runId: run.id,
      seq: 3,
      kind: 'state',
      payload: { status: 'running' },
    })).toThrow('run_terminal');
    const completed = store.getRun(run.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.finalMessageId).toBeTruthy();

    const messages = store.listMessages(conv.id, 'alice@xvirobotics.com');
    expect(messages.map((m) => [m.kind, m.content, m.runId])).toEqual([
      ['user', 'hello', null],
      ['assistant', 'final answer', run.id],
    ]);
    expect(store.listRunEventsForUser(run.id, 'alice@xvirobotics.com').map((e) => e.seq)).toEqual([1, 2]);
  });

  it('records file metadata from run file events with storage keys', () => {
    kit = makeKit('chat-store-files');
    const store = new ChatStore(kit.db, kit.logger);
    const conv = store.createConversation({
      kind: 'dm',
      createdBy: 'alice@xvirobotics.com',
      participants: [{ kind: 'agent', ref: 'metabot' }],
    });
    const trigger = store.appendMessage({
      conversationId: conv.id,
      kind: 'user',
      senderKind: 'user',
      senderRef: 'alice@xvirobotics.com',
      content: 'make a file',
    });
    const run = store.createRun({
      conversationId: conv.id,
      triggerMessageId: trigger.id,
      targetAgentRef: 'metabot',
    });

    store.appendRunEvent({
      runId: run.id,
      seq: 1,
      kind: 'file',
      payload: {
        files: [
          {
            name: 'report.txt',
            mimeType: 'text/plain',
            sizeBytes: 12,
            storageKey: 'runs/report.txt',
          },
        ],
      },
    });

    const files = store.listFiles(conv.id, 'alice@xvirobotics.com');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      conversationId: conv.id,
      runId: run.id,
      name: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'runs/report.txt',
      createdBy: 'metabot',
    });
  });
});
