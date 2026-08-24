import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { parseJsonBody, readBody } from '../src/api/routes/helpers.js';

describe('API request body cache', () => {
  it('lets auth verify the exact raw body before the route parses the same bytes', async () => {
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    const raw = JSON.stringify({ requestId: 'request-1', prompt: 'hello' });
    const authRead = readBody(req);
    const routeRead = parseJsonBody(req);
    req.emit('data', Buffer.from(raw));
    req.emit('end');

    await expect(authRead).resolves.toBe(raw);
    await expect(routeRead).resolves.toEqual({ requestId: 'request-1', prompt: 'hello' });
  });
});
