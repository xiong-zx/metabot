import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactDeliveryError,
  ArtifactDeliveryPublisher,
  normalizeArtifactDeliveryConfig,
} from '../src/extensions/artifact-delivery.js';

const temporary: string[] = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-artifact-publish-'));
  temporary.push(root);
  const outputs = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-artifact-output-'));
  temporary.push(outputs);
  return { root, outputs };
}

describe('ArtifactDeliveryPublisher', () => {
  it('archives exact bytes before delivery and reuses an identical canonical version', () => {
    const { root, outputs } = fixture();
    const source = path.join(outputs, 'aam_report-tech_sync-design_20260821_v01.md');
    fs.writeFileSync(source, 'durable bytes');
    const publisher = new ArtifactDeliveryPublisher(
      {
        mode: 'enforce',
        projects: [{ projectId: 'aam', root, chatIds: ['chat-aam'] }],
      },
      logger,
    );
    const first = publisher.prepare('chat-aam', source, path.basename(source));
    const second = publisher.prepare('chat-aam', source, path.basename(source));
    const standalone = 'aam_figures_sync-overview_20260821_v01.md';
    const standaloneKind = publisher.prepare('chat-aam', source, standalone);
    expect(first?.filePath).toBe(path.join(fs.realpathSync(root), 'deliverables', path.basename(source)));
    expect(fs.readFileSync(first!.filePath, 'utf8')).toBe('durable bytes');
    expect(second?.sha256).toBe(first?.sha256);
    expect(standaloneKind?.filePath).toBe(path.join(fs.realpathSync(root), 'deliverables', standalone));
    expect(fs.readFileSync(standaloneKind!.filePath, 'utf8')).toBe('durable bytes');
  });

  it('rejects in-place version conflicts and noncanonical filenames', () => {
    const { root, outputs } = fixture();
    const canonical = 'aam_report-tech_sync-design_20260821_v01.md';
    const source = path.join(outputs, canonical);
    fs.writeFileSync(source, 'new bytes');
    fs.mkdirSync(path.join(root, 'deliverables'));
    fs.writeFileSync(path.join(root, 'deliverables', canonical), 'old bytes');
    const publisher = new ArtifactDeliveryPublisher(
      {
        mode: 'enforce',
        projects: [{ projectId: 'aam', root, chatIds: ['chat-aam'] }],
      },
      logger,
    );
    expect(() => publisher.prepare('chat-aam', source, canonical)).toThrowError(ArtifactDeliveryError);
    expect(() => publisher.prepare('chat-aam', source, 'report.pdf')).toThrow(/canonical artifact filename/u);
  });

  it('does not archive non-target chats or off-mode output', () => {
    const { root, outputs } = fixture();
    const name = 'aam_report-tech_sync-design_20260821_v01.md';
    const source = path.join(outputs, name);
    fs.writeFileSync(source, 'bytes');
    const off = new ArtifactDeliveryPublisher(
      {
        mode: 'off',
        projects: [{ projectId: 'aam', root, chatIds: ['chat-aam'] }],
      },
      logger,
    );
    expect(off.prepare('chat-aam', source, name)).toBeUndefined();
    const enforce = new ArtifactDeliveryPublisher(
      {
        mode: 'enforce',
        projects: [{ projectId: 'aam', root, chatIds: ['chat-aam'] }],
      },
      logger,
    );
    expect(enforce.prepare('other-chat', source, name)).toBeUndefined();
  });

  it('rejects duplicate chat bindings during config normalization', () => {
    expect(() =>
      normalizeArtifactDeliveryConfig({
        projects: [
          { projectId: 'aam', root: '/tmp/aam', chatIds: ['same'] },
          { projectId: 'noise-llm', root: '/tmp/noise', chatIds: ['same'] },
        ],
      }),
    ).toThrow(/unique/u);
  });
});
